"""Database setup: SQLite + SQLAlchemy 2.x.

SQLite keeps the demo zero-config (no Docker, no Postgres). WAL mode lets
reads and writes happen at the same time, which matters once k6 starts
hitting the API with many virtual users.
"""
import os

from sqlalchemy import create_engine, event
from sqlalchemy.pool import NullPool
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")

# SQLite connections are just file handles, so we don't cap them.
#
# The ep01 version had pool_size=20, max_overflow=20 (40 connections max).
# Under a spike that froze the API for good: FastAPI handles a plain `def`
# endpoint in two trips through its 40-thread pool (run the endpoint, then
# validate the response). Between trips, the request still holds its DB
# connection. Once all 40 connections were parked in requests waiting for a
# thread, all 40 threads were waiting for a connection. Nobody could move.
#
# With Postgres/MySQL you can't go unlimited. There, close the session before
# returning from the endpoint, or keep the pool bigger than everything that
# can be in flight at once (and cap that in front of the app).
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False, "timeout": 30}
    if DATABASE_URL.startswith("sqlite")
    else {},
    poolclass=NullPool if DATABASE_URL.startswith("sqlite") else None,
)


if DATABASE_URL.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency: one DB session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
