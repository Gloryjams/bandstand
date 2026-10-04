import { useEffect, useRef, useState, type FormEvent } from "react";

import { PairQr } from "../components/PairQr";
import { copyText } from "../lib/copy-text";
import {
  NAME_MAX, buildSignInLink, cleanMemberName, inviteErrorMessage, inviteMember,
  listMembers, replaceInvite, type MemberRow, type MintedInvite,
} from "../lib/members";
import { useUi } from "../lib/store";

/**
 * The bandleader's door for adding players. Type a name, get a sign-in link, send it.
 * The link carries the player's key and the server shows that key exactly once, so
 * the page holds it only until "Done". Everything here talks to the server directly:
 * there is no offline queue for minting keys, and a member sees none of it.
 */
export function People() {
  const identity = useUi((s) => s.identity);
  const pairing = useUi((s) => s.pairing);
  const online = useUi((s) => s.online);
  const isMember = identity?.role === "member";

  return (
    <main className="workspace-page">
      <p className="eyebrow">Workspace</p><h1>People</h1>
      <div className="workspace-list-row">
        <strong>{identity?.name ?? "Director"}</strong>
        <span>{isMember ? "Member" : "Bandleader"} · this device</span>
      </div>
      {isMember ? (
        <p className="workspace-empty">
          Your bandleader adds players and sends each one a sign-in link. Open yours on
          any phone or tablet to get in.
        </p>
      ) : identity === null ? (
        // Not known yet who this device is (refreshIdentity always resolves, cache or
        // fallback). Waiting keeps a member's device from asking for the player list.
        null
      ) : pairing ? (
        <Bandleader serverUrl={pairing.url} online={online} />
      ) : (
        <p className="workspace-empty">Sign this device in first.</p>
      )}
    </main>
  );
}

function Bandleader({ serverUrl, online }: { serverUrl: string; online: boolean }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedInvite | null>(null);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [replaceId, setReplaceId] = useState<string | null>(null);
  // Guards the POST synchronously: `busy` only disables the button on the next
  // render, and two taps in one frame would mint two keys and show only the second.
  const minting = useRef(false);

  function load(alive: () => boolean = () => true): Promise<void> {
    return listMembers().then(
      (rows) => { if (alive()) { setMembers(rows); setListFailed(false); } },
      () => { if (alive()) { setMembers(null); setListFailed(true); } },
    );
  }
  useEffect(() => {
    if (!online) return;
    let alive = true;
    void load(() => alive);
    return () => { alive = false; };
  }, [online]);

  async function mint(run: () => Promise<MintedInvite>) {
    if (minting.current) return;
    minting.current = true;
    setBusy(true);
    setError(null);
    try {
      setMinted(await run());
      setName("");
      setReplaceId(null);
      await load();
    } catch (err) {
      setError(inviteErrorMessage(err));
    } finally {
      minting.current = false;
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const clean = cleanMemberName(name);
    if (!clean) { setError("Enter a name."); return; }
    void mint(() => inviteMember(clean));
  }

  const canSubmit = online && !busy && cleanMemberName(name) !== null;
  const active = members?.filter((m) => m.role === "member" && !m.revoked_at) ?? [];

  return (
    <>
      <section className="people-add">
        <h2>Add a player</h2>
        <form onSubmit={submit} className="people-form">
          <label>
            Player&rsquo;s name
            <input
              value={name}
              maxLength={NAME_MAX}
              autoComplete="off"
              placeholder="Rea"
              disabled={busy || !online}
              onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
            />
          </label>
          <button type="submit" className="btn" disabled={!canSubmit}>
            {busy ? "Making a link…" : "Make sign-in link"}
          </button>
        </form>
        {!online && <p className="settings-hint">Adding players needs the server. Reconnect and try again.</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {minted && (
        <section className="people-link" aria-label={`Sign-in link for ${minted.name}`}>
          <h2>Sign-in link for {minted.name}</h2>
          <LinkCard serverUrl={serverUrl} invite={minted} />
          <button className="btn people-done" onClick={() => setMinted(null)}>Done</button>
        </section>
      )}

      <section className="people-list">
        <h2>Players</h2>
        {!online ? (
          <p className="workspace-empty">The list of players needs the server.</p>
        ) : listFailed ? (
          <p className="workspace-empty">Could not load the players. Check the server is running.</p>
        ) : members === null ? (
          <p className="settings-hint">Loading…</p>
        ) : active.length === 0 ? (
          <div className="workspace-empty people-empty">
            <p><strong>No players yet.</strong></p>
            <p>
              A sign-in link is a web address that carries a player&rsquo;s key. They open it
              on their phone or tablet, tap once, and they are in the band: every chart,
              setlist and recording, ready to read. They cannot change anything.
            </p>
            <p>Type a name above to make the first one.</p>
          </div>
        ) : (
          <ul className="people-rows">
            {active.map((m) => (
              <li key={m.id} className="workspace-list-row people-row">
                <strong>{m.name}</strong>
                <span>Member · added {new Date(m.created_at).toLocaleDateString()}</span>
                {replaceId === m.id ? (
                  <span className="row-confirm">
                    <span className="row-confirm-q">The old link stops working.</span>
                    <button disabled={busy} onClick={() => mint(() => replaceInvite(m.id))}>New link</button>
                    <button disabled={busy} onClick={() => setReplaceId(null)}>Keep</button>
                  </span>
                ) : (
                  <button className="btn people-replace" disabled={busy} onClick={() => setReplaceId(m.id)}>
                    New link
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function LinkCard({ serverUrl, invite }: { serverUrl: string; invite: MintedInvite }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const link = buildSignInLink(serverUrl, invite.key);
  const name = invite.name;
  return (
    <>
      <PairQr
        url={serverUrl}
        pairKey={invite.key}
        hint={`${name} scans this with their camera, checks that it names your band, and taps Add band.`}
      />
      <div className="share-url">
        <span className="share-url-text">{link}</span>
        <button className="btn share-copy" onClick={async () => setCopied((await copyText(link)) ? "yes" : "no")}>
          {copied === "yes" ? "Copied" : "Copy"}
        </button>
      </div>
      {copied === "no" && (
        <p className="share-hint">Couldn&rsquo;t copy automatically. Select the link and copy it.</p>
      )}
      <p className="share-note">
        Send this to {name} privately, the way you would send a password. Anyone who opens
        it is signed in as {name}. It is shown once: if it gets lost, make a new link from
        the list and the old one stops working. The link uses the address this device
        signed in with, so {name} needs to be able to reach that address too.
      </p>
    </>
  );
}
