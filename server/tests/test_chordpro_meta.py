from server.ingest import chordpro_meta


def test_parse_title():
    text = "{title: Take Five}\n[Em7]Hello"
    info = chordpro_meta.parse(text)
    assert info.title == "Take Five"


def test_parse_artist_alias_for_composer():
    info = chordpro_meta.parse("{artist: Dave Brubeck}\n")
    assert info.composer == "Dave Brubeck"


def test_parse_key():
    info = chordpro_meta.parse("{key: Eb}\n")
    assert info.music_key == "Eb"


def test_parse_short_form_t_st():
    info = chordpro_meta.parse("{t: Misty}\n{st: Erroll Garner}\n")
    assert info.title == "Misty"
    assert info.composer == "Erroll Garner"


def test_parse_no_directives():
    info = chordpro_meta.parse("[C]Just chords and lyrics")
    assert info.title is None
    assert info.composer is None
    assert info.music_key is None


def test_malformed_directive_does_not_swallow_following_lines():
    info = chordpro_meta.parse("{title: Take Five\n{key: Eb}\n")
    # The first directive is malformed (no closing brace before newline);
    # we should still pick up `key: Eb`.
    assert info.title is None
    assert info.music_key == "Eb"
