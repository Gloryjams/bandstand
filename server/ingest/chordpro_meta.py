import re
from dataclasses import dataclass

_DIRECTIVE = re.compile(r"\{\s*([a-zA-Z_]+)\s*:\s*([^}\n]+)\}")
_TITLE_KEYS = {"title", "t"}
_COMPOSER_KEYS = {"artist", "composer", "subtitle", "st"}
_KEY_KEYS = {"key"}


@dataclass(frozen=True)
class ChordProInfo:
    title: str | None
    composer: str | None
    music_key: str | None


def parse(text: str) -> ChordProInfo:
    title = composer = music_key = None
    for m in _DIRECTIVE.finditer(text):
        name = m.group(1).lower()
        value = m.group(2).strip()
        if name in _TITLE_KEYS and not title:
            title = value
        elif name in _COMPOSER_KEYS and not composer:
            composer = value
        elif name in _KEY_KEYS and not music_key:
            music_key = value
    return ChordProInfo(title=title, composer=composer, music_key=music_key)
