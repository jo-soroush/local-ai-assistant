import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_MESSAGE_CHARS = 4000
MAX_CONTEXT_CHARS = 16000
MAX_PATH_CHARS = 500
_LANGUAGE_RE = re.compile(r"^[A-Za-z0-9_+.\-]{1,50}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


def _workspace_relative(value: str) -> str:
    if _CONTROL_RE.search(value) or "\\" in value:
        raise ValueError("path contains invalid characters")
    if value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise ValueError("path must be workspace-relative")
    if any(part in ("", ".", "..") for part in value.split("/")):
        raise ValueError("path must not contain empty, '.' or '..' segments")
    return value


class EditorContext(BaseModel):
    """Code the extension chose to send. Path is display metadata only; the backend never opens it."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["selection", "file"]
    path: str = Field(min_length=1, max_length=MAX_PATH_CHARS)
    language: str | None = None
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    text: str = Field(max_length=MAX_CONTEXT_CHARS)

    @field_validator("path")
    @classmethod
    def relative_path(cls, value: str) -> str:
        return _workspace_relative(value)

    @field_validator("language")
    @classmethod
    def language_label(cls, value: str | None) -> str | None:
        if value is not None and not _LANGUAGE_RE.fullmatch(value):
            raise ValueError("language is not a valid label")
        return value

    @field_validator("text")
    @classmethod
    def text_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("context text must not be empty")
        return value

    @model_validator(mode="after")
    def line_range(self) -> "EditorContext":
        if self.end_line < self.start_line:
            raise ValueError("end_line must be >= start_line")
        return self


class ToolResult(BaseModel):
    """Result of an extension-side tool run on the user's behalf. The backend never opens the path."""

    model_config = ConfigDict(extra="forbid")

    tool: Literal["read_file"]
    path: str = Field(min_length=1, max_length=MAX_PATH_CHARS)
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    text: str = Field(max_length=MAX_CONTEXT_CHARS)

    @field_validator("path")
    @classmethod
    def relative_path(cls, value: str) -> str:
        return _workspace_relative(value)

    @field_validator("text")
    @classmethod
    def text_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("tool result text must not be empty")
        return value

    @model_validator(mode="after")
    def line_range(self) -> "ToolResult":
        if self.end_line < self.start_line:
            raise ValueError("end_line must be >= start_line")
        return self


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(max_length=MAX_MESSAGE_CHARS)
    context: EditorContext | None = None
    tool_results: list[ToolResult] = Field(default_factory=list, max_length=1)

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
