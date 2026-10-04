from fastapi import APIRouter, Depends

from server import auth
from server.members import Identity

router = APIRouter()


@router.get("/api/whoami")
def whoami(ident: Identity = Depends(auth.require_identity)):
    """Who does the presented key belong to? Drives client role-gating: a member
    client hides author affordances. Older servers 404 this route; the client
    treats that as director (pre-members behavior preserved)."""
    return {"id": ident.id, "name": ident.name, "role": ident.role}
