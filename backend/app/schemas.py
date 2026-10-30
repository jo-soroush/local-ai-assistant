from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_MESSAGE_CHARS = 4000


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(max_length=MAX_MESSAGE_CHARS)

    @field_validator("message")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("message must not be empty")
        return value


class ChatResponse(BaseModel):
    request_id: str
    reply: str


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail
    request_id: str
