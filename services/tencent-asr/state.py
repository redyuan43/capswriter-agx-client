from dataclasses import dataclass, field
from aiohttp import web


@dataclass
class Runtime:
    quota: object
    provider: object = None
    sockets: set = field(default_factory=set)
    file_active: int = 0


STATE = web.AppKey("runtime", Runtime)
