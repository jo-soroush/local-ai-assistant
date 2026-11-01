import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .llm.base import LLMError, LLMProvider
from .llm.factory import get_provider
from .prompt import build_messages
from .schemas import MAX_MESSAGE_CHARS, ChatRequest, ChatResponse

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
# Message plus 16k chars of context and 16k of attached file, worst-case JSON-escaped (6 bytes/char), fits with headroom.
# Enforced on bytes actually received.
MAX_BODY_BYTES = 256 * 1024

logger = logging.getLogger("rise.backend")


@asynccontextmanager
async def lifespan(_: FastAPI):
    get_provider()  # fail fast on invalid configuration
    yield


app = FastAPI(title="RISE Local AI Assistant Backend", version="0.1.0", lifespan=lifespan)


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", None) or str(uuid.uuid4())


_TOO_LARGE_MESSAGE = f"Request body exceeds {MAX_BODY_BYTES} bytes."


def _error(request: Request, status: int, code: str, message: str) -> JSONResponse:
    request_id = _request_id(request)
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}, "request_id": request_id},
        headers={"X-Request-ID": request_id},
    )


def _too_large(request: Request) -> JSONResponse:
    return _error(request, 413, "payload_too_large", _TOO_LARGE_MESSAGE)


class RequestContextMiddleware:
    """Assigns the request ID and enforces MAX_BODY_BYTES on the bytes actually received.

    Pure ASGI so the limit also applies to chunked bodies and bodies without Content-Length.
    """

    def __init__(self, asgi_app: ASGIApp) -> None:
        self.app = asgi_app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = str(uuid.uuid4())
        scope.setdefault("state", {})["request_id"] = request_id

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if "x-request-id" not in headers:
                    headers["X-Request-ID"] = request_id
            await send(message)

        request = Request(scope)
        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            await _too_large(request)(scope, receive, send_with_id)
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_BODY_BYTES:
                    raise StarletteHTTPException(413, _TOO_LARGE_MESSAGE)
            return message

        await self.app(scope, limited_receive, send_with_id)


app.add_middleware(RequestContextMiddleware)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    parts = []
    for err in exc.errors():
        field = ".".join(str(p) for p in err["loc"] if p != "body") or "body"
        parts.append(f"{field}: {err['msg']}")
    return _error(request, 422, "validation_error", "; ".join(parts))


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    code = {404: "not_found", 405: "method_not_allowed", 413: "payload_too_large"}.get(exc.status_code, "http_error")
    return _error(request, exc.status_code, code, str(exc.detail))


@app.exception_handler(LLMError)
async def llm_error(request: Request, exc: LLMError):
    logger.warning("llm error %s (request %s)", exc.code, _request_id(request))
    return _error(request, exc.status_code, exc.code, exc.message)


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception):
    return _error(request, 500, "internal_error", "Internal server error.")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/chat", response_model=ChatResponse)
async def chat(
    body: ChatRequest, request: Request, provider: LLMProvider = Depends(get_provider)
) -> ChatResponse:
    reply = await provider.generate(build_messages(body.message, body.context, body.tool_results))
    return ChatResponse(request_id=_request_id(request), reply=reply)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=DEFAULT_HOST, port=DEFAULT_PORT)
