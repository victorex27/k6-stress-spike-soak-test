from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# ---------- Users / auth ----------
class SignupRequest(BaseModel):
    email: EmailStr
    # bcrypt only uses the first 72 bytes of a password, so cap it here.
    password: str = Field(min_length=8, max_length=72)
    full_name: str = Field(min_length=1, max_length=120)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    full_name: str
    created_at: datetime


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=120)


# ---------- Items ----------
class ItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    price: float = Field(ge=0, default=0)
    quantity: int = Field(ge=0, default=0)


class ItemUpdate(BaseModel):
    """PATCH body: every field optional, only the ones sent are changed."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    price: float | None = Field(default=None, ge=0)
    quantity: int | None = Field(default=None, ge=0)


class ItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None
    price: float
    quantity: int
    owner_id: int
    created_at: datetime
    updated_at: datetime


# ---------- Activity ----------
class ActivityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    item_id: int
    action: str
    created_at: datetime
