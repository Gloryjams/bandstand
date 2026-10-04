import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { db, type Setlist } from "../lib/db";

export function Gigs() {
  const [gigs, setGigs] = useState<Setlist[]>([]);
  useEffect(() => {
    void db.setlists.toArray().then((rows) =>
      setGigs(rows.filter((row) => row.date || row.venue).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))),
    );
  }, []);
  return (
    <main className="workspace-page">
      <p className="eyebrow">Workspace</p><h1>Gigs</h1>
      {gigs.length ? gigs.map((gig) => (
        <Link className="workspace-list-row" to={`/setlists/${gig.id}`} key={gig.id}>
          <strong>{gig.name}</strong>
          <span>{[gig.date, gig.venue].filter(Boolean).join(" · ")}</span>
        </Link>
      )) : <p className="workspace-empty">Add a date or venue to a set and it will become a gig here.</p>}
    </main>
  );
}
