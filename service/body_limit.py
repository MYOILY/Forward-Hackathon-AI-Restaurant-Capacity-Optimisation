"""Bound request bytes before multipart parsing can spool them to disk."""

from starlette.formparsers import MultiPartException


def request_limit(path, limits):
    if path == "/api/videos":
        maximum = limits["upload_bytes"]
    elif path.startswith("/api/sources/") and "/setup-assets/" in path:
        maximum = limits.get("setup_asset_bytes", 12 * 1024 * 1024)
    else:
        maximum = limits["frame_bytes"] * 2
    return maximum + 65536


class RequestBodyLimit:
    def __init__(self, app, limits):
        self.app, self.limits = app, limits

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = request_limit(scope["path"], self.limits)
        count, exceeded = 0, False

        async def bounded_receive():
            nonlocal count, exceeded
            message = await receive()
            if message["type"] == "http.request":
                count += len(message.get("body", b""))
                if count > limit:
                    exceeded = True
                    # MultiPartParser closes every partially spooled file on
                    # this exception. FastAPI renders its normal error body.
                    raise MultiPartException(
                        "Request exceeds the configured size limit."
                    )
            return message

        async def bounded_send(message):
            if exceeded and message["type"] == "http.response.start":
                message = {**message, "status": 413}
            await send(message)

        await self.app(scope, bounded_receive, bounded_send)
