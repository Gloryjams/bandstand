import { useEffect, useState } from "react";

import { db } from "../lib/db";
import { parseItems, serializeItems, eraseAt, type Item, type Stroke } from "../lib/annot";
import { queueWrite } from "../lib/sync-queue";

const ERASE_RADIUS = 0.02; // normalized page units

/**
 * Owns one page's annotation items (freehand strokes + typed text labels): loads them,
 * keeps a 50-deep undo/redo history, and persists every change (Dexie-first, queued for
 * the server). Text and strokes share this one history + persistence path. Re-keys on
 * page change.
 */
export function useAnnotations(pieceId: string | null, fileId: string | null, pageIndex: number) {
  const [items, setItems] = useState<Item[]>([]);
  const [undoStack, setUndoStack] = useState<Item[][]>([]);
  const [redoStack, setRedoStack] = useState<Item[][]>([]);

  // Load this page's items; reset the per-page history.
  useEffect(() => {
    let alive = true;
    setUndoStack([]);
    setRedoStack([]);
    if (!pieceId || !fileId) {
      setItems([]);
      return;
    }
    (async () => {
      const row = await db.annotations.get([pieceId, fileId, pageIndex]);
      if (alive) setItems(row ? parseItems(row.svg_paths) : []);
    })();
    return () => {
      alive = false;
    };
  }, [pieceId, fileId, pageIndex]);

  // Empty -> delete the row; otherwise upsert. Dexie keeps the serialized string; the
  // server json.dumps the array on its side.
  async function save(next: Item[]) {
    if (!pieceId || !fileId) return;
    const updated_at = Date.now();
    if (next.length === 0) {
      await db.annotations.delete([pieceId, fileId, pageIndex]);
      await queueWrite("delete", "annotations", { piece_id: pieceId, file_id: fileId, page_index: pageIndex });
    } else {
      await db.annotations.put({ piece_id: pieceId, file_id: fileId, page_index: pageIndex, svg_paths: serializeItems(next), updated_at });
      await queueWrite("upsert", "annotations", { piece_id: pieceId, file_id: fileId, page_index: pageIndex, svg_paths: next, updated_at });
    }
  }

  function apply(next: Item[]) {
    setUndoStack((u) => [...u, items].slice(-50));
    setRedoStack([]);
    setItems(next);
    void save(next);
  }
  function commitStroke(s: Stroke) {
    apply([...items, s]);
  }
  // The single entry point for every text mutation (add / edit / move / delete): the
  // caller computes the next array, this routes it through the shared history + persist.
  function commitItems(next: Item[]) {
    apply(next);
  }
  function eraseStroke(point: [number, number]) {
    const { strokes: kept, erased } = eraseAt(items, point, ERASE_RADIUS);
    if (erased.length) apply(kept);
  }
  function undo() {
    const prev = undoStack[undoStack.length - 1];
    if (!prev) return;
    setRedoStack((r) => [...r, items].slice(-50));
    setUndoStack((u) => u.slice(0, -1));
    setItems(prev);
    void save(prev);
  }
  function redo() {
    const nextS = redoStack[redoStack.length - 1];
    if (!nextS) return;
    setUndoStack((u) => [...u, items].slice(-50));
    setRedoStack((r) => r.slice(0, -1));
    setItems(nextS);
    void save(nextS);
  }

  return {
    items,
    commitStroke,
    commitItems,
    eraseStroke,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  };
}
