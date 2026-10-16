"""Demo API for "Stress vs spike vs soak test in k6" — the ep01 API plus two
bugs that only show up over time (marked SOAK BUG below).

Run:  fastapi dev app/main.py      (auto-reload, for development)
      fastapi run app/main.py      (no reload, use this when load testing)
Docs: http://localhost:8000/docs
"""
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import create_access_token, get_current_user, hash_password, verify_password
from .db import Base, engine, get_db
from .models import ActivityLog, Item, User
from .schemas import (
    ActivityOut,
    ItemCreate,
    ItemOut,
    ItemUpdate,
    LoginRequest,
    SignupRequest,
    TokenResponse,
    UserOut,
    UserUpdate,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)  # create tables on startup
    yield


app = FastAPI(
    title="k6 Demo API",
    version="1.1.0",
    description="Signup, login, users and items — a realistic API to load test with k6.",
    lifespan=lifespan,
)


# SOAK BUG #1 (on purpose): a "recently viewed" cache that never evicts.
# Every GET /items/{id} appends a snapshot of the item for that user. Nothing
# ever removes entries, so the process uses a little more memory with every
# request. A short test never notices. A soak test does.
RECENTLY_VIEWED: dict[int, list[dict]] = {}


# ---------------------------------------------------------------- health
@app.get("/health", tags=["health"])
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------- auth
@app.post("/auth/signup", response_model=UserOut, status_code=status.HTTP_201_CREATED, tags=["auth"])
def signup(body: SignupRequest, db: Session = Depends(get_db)):
    user = User(
        email=body.email.lower(),
        full_name=body.full_name,
        hashed_password=hash_password(body.password),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
    db.refresh(user)
    return user


@app.post("/auth/login", response_model=TokenResponse, tags=["auth"])
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if user is None or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    token, expires_in = create_access_token(user.id)
    return TokenResponse(access_token=token, expires_in=expires_in)


# ---------------------------------------------------------------- users
@app.get("/users/me", response_model=UserOut, tags=["users"])
def get_me(current: User = Depends(get_current_user)):
    return current


@app.patch("/users/me", response_model=UserOut, tags=["users"])
def update_me(body: UserUpdate, current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(current, field, value)
    db.add(current)
    db.commit()
    db.refresh(current)
    return current


@app.get("/users/me/recent", response_model=list[ItemOut], tags=["users"])
def get_recently_viewed(current: User = Depends(get_current_user)):
    """The last 5 distinct items this user opened (newest first)."""
    seen, recent = set(), []
    for snap in reversed(RECENTLY_VIEWED.get(current.id, [])):
        if snap["id"] not in seen:
            seen.add(snap["id"])
            recent.append(snap)
        if len(recent) == 5:
            break
    return recent


@app.get("/users/me/activity", response_model=list[ActivityOut], tags=["users"])
def get_activity(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every item this user opened or changed, newest first.

    SOAK BUG #2: no LIMIT, and activity_log.user_id has no index, so every call
    scans the whole table and returns the user's whole history.
    """
    stmt = select(ActivityLog).where(ActivityLog.user_id == current.id).order_by(ActivityLog.id.desc())
    return db.scalars(stmt).all()


@app.get("/users/{user_id}", response_model=UserOut, tags=["users"])
def get_user(user_id: int, _: User = Depends(get_current_user), db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return user


# ---------------------------------------------------------------- items
def _get_owned_item(item_id: int, owner: User, db: Session) -> Item:
    item = db.get(Item, item_id)
    # 404 (not 403) so we don't leak which item IDs exist for other users
    if item is None or item.owner_id != owner.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found")
    return item


@app.post("/items", response_model=ItemOut, status_code=status.HTTP_201_CREATED, tags=["items"])
def create_item(body: ItemCreate, current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    item = Item(**body.model_dump(), owner_id=current.id)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@app.get("/items", response_model=list[ItemOut], tags=["items"])
def list_items(
    skip: int = 0,
    limit: int = 20,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    limit = max(1, min(limit, 100))
    stmt = select(Item).where(Item.owner_id == current.id).order_by(Item.id).offset(skip).limit(limit)
    return db.scalars(stmt).all()


@app.get("/items/{item_id}", response_model=ItemOut, tags=["items"])
def get_item(item_id: int, current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    item = _get_owned_item(item_id, current, db)
    RECENTLY_VIEWED.setdefault(current.id, []).append(ItemOut.model_validate(item).model_dump())
    db.add(ActivityLog(user_id=current.id, item_id=item.id, action="item.viewed"))
    db.commit()
    return item


@app.patch("/items/{item_id}", response_model=ItemOut, tags=["items"])
def update_item(
    item_id: int,
    body: ItemUpdate,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    item = _get_owned_item(item_id, current, db)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(item, field, value)
    db.add(ActivityLog(user_id=current.id, item_id=item.id, action="item.updated"))
    db.commit()
    db.refresh(item)
    return item


@app.delete("/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["items"])
def delete_item(item_id: int, current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    item = _get_owned_item(item_id, current, db)
    db.delete(item)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)

