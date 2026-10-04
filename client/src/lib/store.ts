import { create } from "zustand";

import type { Piece } from "./db";
import type { ChartEditorState } from "./chart-editor";
import type { Identity } from "./identity";
import type { BandPairing } from "./meta";

interface UiState {
  pairing: { url: string; key: string } | null | undefined;
  online: boolean;
  identity: Identity | null;
  chartEditor: ChartEditorState;
  bands: BandPairing[];
  activeBandId: string | null;
  setBands: (bands: BandPairing[], activeBandId: string | null) => void;
  setIdentity: (i: Identity | null) => void;
  setChartEditor: (state: ChartEditorState) => void;
  setOnline: (on: boolean) => void;
  setPairing: (p: { url: string; key: string } | null) => void;
  recentPieceIds: string[];
  pushRecent: (id: string) => void;
  setRecents: (ids: string[]) => void;
  quickFindOpen: boolean;
  setQuickFindOpen: (open: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  pairing: undefined, // loading until bootBands resolves; null means no sign-in
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
  identity: null,
  chartEditor: null,
  bands: [],
  activeBandId: null,
  setBands: (bands, activeBandId) => set({ bands, activeBandId }),
  setIdentity: (identity) => set({ identity }),
  setChartEditor: (chartEditor) => set({ chartEditor }),
  setOnline: (on) => set({ online: on }),
  setPairing: (p) => set({ pairing: p }),
  recentPieceIds: [],
  pushRecent: (id) =>
    set((s) => ({
      recentPieceIds: [id, ...s.recentPieceIds.filter((x) => x !== id)].slice(0, 30),
    })),
  setRecents: (recentPieceIds) => set({ recentPieceIds }),
  quickFindOpen: false,
  setQuickFindOpen: (quickFindOpen) => set({ quickFindOpen }),
}));

interface ViewerState {
  piece: Piece | null;
  fileIndex: number;
  pageIndex: number;
  mode: "reading" | "annotate";
  zoom: number;
  setlistId: string | null;
  setlistPosition: number | null;
  setPiece: (p: Piece | null) => void;
  setFileIndex: (i: number) => void;
  setPageIndex: (i: number) => void;
  setMode: (m: "reading" | "annotate") => void;
  setZoom: (z: number) => void;
  setSetlistContext: (id: string | null, pos: number | null) => void;
}

export const useViewer = create<ViewerState>((set) => ({
  piece: null,
  fileIndex: 0,
  pageIndex: 0,
  mode: "reading",
  zoom: 1,
  setlistId: null,
  setlistPosition: null,
  setPiece: (p) => set({ piece: p, fileIndex: 0, pageIndex: 0 }),
  setFileIndex: (fileIndex) => set({ fileIndex, pageIndex: 0 }),
  setPageIndex: (pageIndex) => set({ pageIndex }),
  setMode: (mode) => set({ mode }),
  setZoom: (zoom) => set({ zoom }),
  setSetlistContext: (setlistId, setlistPosition) =>
    set({ setlistId, setlistPosition }),
}));
