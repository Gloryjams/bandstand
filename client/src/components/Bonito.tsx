// Artwork: not covered by the AGPL. See NOTICE.
/**
 * Bonito, the guest cat from the "Bonito x Bandstand · Stage Wardrobe" design handoff
 * (claude.ai/design project "Bonito Expression Sheet"). Ginger conductor-cat with five
 * era outfits and seven expressions; he blinks on his own and bobs while the music plays.
 *
 * Ported for Bandstand's tablet reality: no cursor-follow (it's a finger-driven screen;
 * moods are driven from app state instead, see lib/bonito.ts moodFor), canon colors kept
 * (he's artwork inside the dark chrome, not themeable chrome), animations live in
 * styles.css under the bnt- prefix so prefers-reduced-motion can quiet them.
 */
import { useEffect, useState } from "react";

import type { BonitoExpression, BonitoOutfit } from "../lib/bonito";

const DARK = "#2D1B00";

const FILLBOX: React.CSSProperties = { transformBox: "fill-box", transformOrigin: "center" };
const FILLBOX_TOP: React.CSSProperties = { transformBox: "fill-box", transformOrigin: "center top" };

// eye anchors: [cx, cy]
const L: readonly [number, number] = [35, 42];
const R: readonly [number, number] = [63, 42];

function starPath(cx: number, cy: number, spikes: number, outer: number, inner: number): string {
  let rot = -Math.PI / 2;
  const step = Math.PI / spikes;
  let d = `M ${cx + Math.cos(rot) * outer} ${cy + Math.sin(rot) * outer}`;
  for (let i = 0; i < spikes; i++) {
    rot += step; d += ` L ${cx + Math.cos(rot) * inner} ${cy + Math.sin(rot) * inner}`;
    rot += step; d += ` L ${cx + Math.cos(rot) * outer} ${cy + Math.sin(rot) * outer}`;
  }
  return d + " Z";
}
function heartPath(cx: number, cy: number, s: number): string {
  return `M ${cx} ${cy + 3.3 * s} C ${cx - 3.6 * s} ${cy - 0.2 * s} ${cx - 3.2 * s} ${cy - 4 * s} ${cx} ${cy - 1.4 * s} C ${cx + 3.2 * s} ${cy - 4 * s} ${cx + 3.6 * s} ${cy - 0.2 * s} ${cx} ${cy + 3.3 * s} Z`;
}

/* ---------------- eyes ---------------- */
function NormalEyes({ sz }: { sz: number }) {
  const eye = ([cx, cy]: readonly [number, number]) => (
    <g key={cx}>
      <ellipse cx={cx} cy={cy} rx={5 * sz} ry={5.5 * sz} fill={DARK} />
      <circle cx={cx + 2 * sz} cy={cy - 2 * sz} r={2 * sz} fill="#fff" />
      <circle cx={cx - 1.4 * sz} cy={cy + 1.6 * sz} r={1 * sz} fill="#fff" opacity={0.45} />
    </g>
  );
  return <g>{eye(L)}{eye(R)}</g>;
}
function BlinkEyes() {
  const arc = ([cx, cy]: readonly [number, number]) => (
    <path key={cx} d={`M${cx - 4.5} ${cy} Q ${cx} ${cy + 1.8} ${cx + 4.5} ${cy}`}
          stroke={DARK} strokeWidth={1.7} fill="none" strokeLinecap="round" />
  );
  return <g>{arc(L)}{arc(R)}</g>;
}
function HeartEyes() {
  const ht = ([cx, cy]: readonly [number, number]) => (
    <g key={cx} className="bnt-a-heart" style={FILLBOX}>
      <path d={heartPath(cx, cy, 1.7)} fill="#FF6B9D" />
      <circle cx={cx - 1.3} cy={cy - 1} r={0.9} fill="#fff" opacity={0.85} />
    </g>
  );
  return <g>{ht(L)}{ht(R)}</g>;
}
function StarEyes() {
  const st = ([cx, cy]: readonly [number, number]) => (
    <g key={cx} className="bnt-a-twinkle" style={FILLBOX}>
      <path d={starPath(cx, cy, 5, 5.4, 2.3)} fill="#FFD23F" stroke="#E8B800" strokeWidth={0.3} strokeLinejoin="round" />
      <circle cx={cx} cy={cy - 0.4} r={1.1} fill="#fff" opacity={0.9} />
    </g>
  );
  return <g>{st(L)}{st(R)}</g>;
}
function WinkEyes() {
  return (
    <g>
      <g>
        <ellipse cx={L[0]} cy={L[1]} rx={5} ry={5.5} fill={DARK} />
        <circle cx={L[0] + 2} cy={L[1] - 2} r={2} fill="#fff" />
        <circle cx={L[0] - 1.4} cy={L[1] + 1.6} r={1} fill="#fff" opacity={0.45} />
      </g>
      <path d={`M${R[0] - 4.6} ${R[1] + 1.4} Q ${R[0]} ${R[1] - 3} ${R[0] + 4.6} ${R[1] + 1.4}`}
            stroke={DARK} strokeWidth={1.8} fill="none" strokeLinecap="round" />
    </g>
  );
}
function SleepyEyes() {
  const eye = ([cx, cy]: readonly [number, number]) => (
    <g key={cx}>
      <path d={`M${cx - 4.5} ${cy + 0.6} Q ${cx} ${cy + 3.6} ${cx + 4.5} ${cy + 0.6} Q ${cx} ${cy + 1.8} ${cx - 4.5} ${cy + 0.6} Z`} fill={DARK} />
      <path d={`M${cx - 5} ${cy - 0.2} Q ${cx} ${cy + 1} ${cx + 5} ${cy - 0.2}`}
            stroke="#D4802A" strokeWidth={1} fill="none" strokeLinecap="round" />
    </g>
  );
  return <g>{eye(L)}{eye(R)}</g>;
}

function Brow({ d }: { d: string }) {
  return <path d={d} stroke="#D4802A" strokeWidth={1.2} fill="none" strokeLinecap="round" />;
}
function SurprisedBrows() {
  return (
    <g>
      <Brow d={`M${L[0] - 4} 34.5 Q ${L[0]} 32 ${L[0] + 4} 33.8`} />
      <Brow d={`M${R[0] - 4} 33.8 Q ${R[0]} 32 ${R[0] + 4} 34.5`} />
    </g>
  );
}
function CuriousBrows() {
  return (
    <g>
      <Brow d={`M${L[0] - 4} 34 Q ${L[0]} 30.3 ${L[0] + 4} 32.4`} />
      <Brow d={`M${R[0] - 4} 35 Q ${R[0]} 34 ${R[0] + 4} 35`} />
    </g>
  );
}

/* ---------------- mouths ---------------- */
const MS = { stroke: DARK, strokeWidth: 1.5, fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;
const Bridge = <line x1={49} y1={48.6} x2={49} y2={50.2} stroke={DARK} strokeWidth={1} strokeLinecap="round" />;

function Mouth({ expr }: { expr: BonitoExpression }) {
  switch (expr) {
    case "happy":
      return <g>{Bridge}<path d="M44 51 Q46 53.6 49 51 Q52 53.6 54 51" {...MS} /></g>;
    case "curious":
      return <g>{Bridge}<path d="M46 51.2 Q48 53 50 51.4 Q52 52.6 53.5 51.2" {...MS} strokeWidth={1.4} /></g>;
    case "surprised":
    case "star-struck":
      return (
        <g>
          <ellipse cx={49} cy={52.6} rx={2.1} ry={2.7} fill={DARK} />
          <ellipse cx={49} cy={53.4} rx={1.1} ry={1.2} fill="#E36588" opacity={0.7} />
        </g>
      );
    case "wink":
      return (
        <g>
          {Bridge}
          <path d="M44 50.8 Q49 54.6 54 50.8" {...MS} />
          <g className="bnt-a-mlem" style={FILLBOX_TOP}>
            <path d="M50.6 52.6 Q50.2 56.8 52.6 56.6 Q54.4 56.2 53.6 51.9 Z" fill="#FF8FA8" stroke="#E36588" strokeWidth={0.4} />
          </g>
        </g>
      );
    case "sleepy":
      return (
        <g className="bnt-a-yawn" style={FILLBOX_TOP}>
          <path d="M43.4 50.6 Q49 49.2 54.6 50.6 Q55.6 58 49 60.8 Q42.4 58 43.4 50.6 Z" fill="#7A2230" />
          <path d="M44.8 50.9 Q49 53 53.2 50.9 Q49 51.7 44.8 50.9 Z" fill="#C44" opacity={0.5} />
          <path d="M45.2 50.8 L46.6 54.6 L48 50.9 Z" fill="#fff" />
          <path d="M50 50.9 L51.4 54.6 L52.8 50.8 Z" fill="#fff" />
          <path d="M46.3 59.4 L47.4 56.2 L48.5 59.4 Z" fill="#fff" opacity={0.92} />
          <path d="M49.5 59.4 L50.6 56.2 L51.7 59.4 Z" fill="#fff" opacity={0.92} />
          <path d="M46.6 56.6 Q49 60.6 51.4 56.6 Q49 57.9 46.6 56.6 Z" fill="#FF8FA8" />
        </g>
      );
    case "in-love":
      return (
        <g>
          {Bridge}
          <path d="M44 50.9 Q46.4 53.4 49 51.3 Q51.6 53.4 54 50.9" {...MS} />
          <g className="bnt-a-mlem" style={FILLBOX_TOP}>
            <path d="M46.5 52 Q46.1 57.8 49 57.8 Q51.9 57.8 51.5 52 Z" fill="#FF8FA8" stroke="#E36588" strokeWidth={0.4} />
            <line x1={49} y1={53.2} x2={49} y2={56.6} stroke="#E36588" strokeWidth={0.6} strokeLinecap="round" />
          </g>
        </g>
      );
  }
}

/* ---------------- outfits (bodies + headwear + face fx) ---------------- */
const Neck = <path d="M41 64 L57 64 L57 67 Q49 70 41 67 Z" fill="url(#bnt-fur)" />;
function Torso({ fill }: { fill: string }) {
  return <path d="M24 70Q24 68 34 66L41 66Q49 68 57 66L64 66Q74 68 74 70L76 106L22 106Z" fill={fill} />;
}
function CollarV({ c, w }: { c: string; w: number }) {
  return <path d="M41 66L49 74L57 66" stroke={c} strokeWidth={w} fill="none" strokeLinejoin="round" />;
}
function Badge({ c }: { c: string }) {
  return (
    <g>
      <rect x={54.5} y={95} width={18} height={7.5} rx={3.6} fill="#fff" opacity={0.96} stroke={c} strokeWidth={0.6} />
      <text x={63.5} y={100.4} textAnchor="middle" fontSize={4} fill={c} fontWeight={900}
            letterSpacing={0.2} fontFamily="var(--display)">BONITO</text>
    </g>
  );
}
function Arms({ sleeve, lGlove, rGlove, sparkle }: { sleeve: string; lGlove: string; rGlove: string; sparkle?: boolean }) {
  return (
    <g>
      <path d="M24 72Q14 76 10 68Q8 63 13 58" stroke={sleeve} strokeWidth={8} fill="none" strokeLinecap="round" />
      <path d="M74 72Q84 78 86 88" stroke={sleeve} strokeWidth={8} fill="none" strokeLinecap="round" />
      <circle cx={13} cy={57} r={4.5} fill={lGlove} />
      <circle cx={86} cy={90} r={4.5} fill={rGlove} />
      {sparkle && (
        <g>
          <path d="M13 52.4 L13.9 55.8 L17.4 56.6 L13.9 57.4 L13 60.8 L12.1 57.4 L8.6 56.6 L12.1 55.8 Z" fill="#fff" />
          <circle cx={10.4} cy={53.4} r={0.7} fill="#fff" />
        </g>
      )}
    </g>
  );
}

function Body({ outfit }: { outfit: BonitoOutfit }) {
  switch (outfit) {
    case "starman":
      return (
        <g>
          {Neck}
          <Torso fill="#1C93A6" />
          <path d="M24 70Q24 68 34 66L41 66Q49 68 49 68L49 106L22 106Z" fill="#2BB9CC" opacity={0.45} />
          <path d="M49 70 L49 106" stroke="#BFEFFF" strokeWidth={0.7} opacity={0.7} />
          <path d={starPath(49, 84, 5, 7.5, 3.2)} fill="#FFD23F" stroke="#E8B800" strokeWidth={0.4} strokeLinejoin="round" />
          <path d="M38 92 L35 99 L39 98 L36 105" stroke="#FF3B5C" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M61 91 L58 98 L62 97 L59 103" stroke="#FF3B5C" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M40 67 L44 72 L49 67 L54 72 L58 67" stroke="#2BB3FF" strokeWidth={2} fill="none" strokeLinejoin="round" />
          <Arms sleeve="#16808F" lGlove="#EAF8FF" rGlove="#EAF8FF" />
          <path d="M9.5 60 L16.5 56" stroke="#FF3B5C" strokeWidth={1.4} strokeLinecap="round" />
          <Badge c="#2BB3FF" />
        </g>
      );
    case "duke":
      return (
        <g>
          {Neck}
          <Torso fill="#F4F1E8" />
          <path d="M24 70Q24 68 34 66L41 66L45.5 74L45.5 106L22 106Z" fill="#191A20" />
          <path d="M74 70Q74 68 64 66L57 66L52.5 74L52.5 106L76 106Z" fill="#191A20" />
          <CollarV c="#FFFFFF" w={2} />
          <path d="M47.6 70 L49 73 L50.4 70 L49.8 90 L49 92 L48.2 90 Z" fill="#15151A" />
          {[80, 86, 92].map((y) => <circle key={y} cx={45.6} cy={y} r={0.85} fill="#7d7d84" />)}
          <Arms sleeve="#EEEAE0" lGlove="#FFFFFF" rGlove="#FFFFFF" />
          <Badge c="#B79235" />
        </g>
      );
    case "thriller":
      return (
        <g>
          {Neck}
          <Torso fill="#D81E2F" />
          <path d="M22 106 L24 70 Q24 68 34 66 L41 66 L41 106 Z" fill="#EC3447" opacity={0.45} />
          <path d="M30 80 L49 88 L68 80" stroke="#161616" strokeWidth={3} fill="none" strokeLinejoin="round" />
          <path d="M30 88 L49 96 L68 88" stroke="#161616" strokeWidth={3} fill="none" strokeLinejoin="round" />
          <line x1={49} y1={74} x2={49} y2={106} stroke="#CFCFCF" strokeWidth={0.9} />
          <path d="M44 67 L49 73.5 L54 67 Z" fill="#161616" />
          <path d="M41 66 L35.5 60 L41.5 67 Z" fill="#161616" />
          <path d="M57 66 L62.5 60 L56.5 67 Z" fill="#161616" />
          <CollarV c="#161616" w={2.2} />
          <Arms sleeve="#C11B29" lGlove="#FFFFFF" rGlove="#E8922A" sparkle />
          <Badge c="#161616" />
        </g>
      );
    case "moonwalk":
      return (
        <g>
          {Neck}
          <Torso fill="#FAFAF5" />
          <path d="M41 66 L49 76 L57 66 L57 106 L41 106 Z" fill="#16171C" />
          <path d="M41 66 L32.5 73 L40 94 L45.5 74 Z" fill="#FFFFFF" stroke="#E4E0D2" strokeWidth={0.5} />
          <path d="M57 66 L65.5 73 L58 94 L52.5 74 Z" fill="#FFFFFF" stroke="#E4E0D2" strokeWidth={0.5} />
          <path d="M47.6 70 L49 72.6 L50.4 70 L49.8 88 L49 90 L48.2 88 Z" fill="#D8D5C6" />
          <Arms sleeve="#F1EEE4" lGlove="#FFFFFF" rGlove="#FFFFFF" sparkle />
          <rect x={81.5} y={84} width={7.5} height={2.4} rx={1.1} fill="#C9A84C" transform="rotate(34 85.2 85.2)" />
          <Badge c="#2B6CB0" />
        </g>
      );
    case "conductor":
      return (
        <g>
          {Neck}
          <Torso fill="url(#bnt-uniform)" />
          <rect x={24} y={68} width={12} height={3.5} rx={1.5} fill="#C9A84C" />
          <rect x={62} y={68} width={12} height={3.5} rx={1.5} fill="#C9A84C" />
          <CollarV c="#FFFFFF" w={2.2} />
          {[78, 86, 94].map((y) => (
            <g key={y}>
              <circle cx={42} cy={y} r={1.8} fill="#C9A84C" />
              <circle cx={56} cy={y} r={1.8} fill="#C9A84C" />
            </g>
          ))}
          <Arms sleeve="#1B3A5C" lGlove="#FFFFFF" rGlove="#FFFFFF" />
          <g>
            <path d="M40 65.5Q49 70 58 65.5" stroke="#FF6B9D" strokeWidth={2.4} fill="none" strokeLinecap="round" />
            <path d="M44 66.5L40.5 63.5L41 68.5Z" fill="#FF6B9D" />
            <path d="M54 66.5L57.5 63.5L57 68.5Z" fill="#FF6B9D" />
            <circle cx={49} cy={67.5} r={2.2} fill="#FFD700" stroke="#E8B800" strokeWidth={0.4} />
          </g>
          <Badge c="#FF6B9D" />
        </g>
      );
  }
}

function Headwear({ outfit }: { outfit: BonitoOutfit }) {
  switch (outfit) {
    case "starman":
      return (
        <g>
          <path d="M16 31 L20 6 L29 25 L36 3 L44 24 L49 0 L54 24 L62 3 L69 25 L78 6 L82 31 Z" fill="#FF3322" />
          <path d="M22 30 L26 12 L33 26 L40 8 L46 25 L49 8 L52 25 L58 8 L65 26 L72 12 L76 30 Z" fill="#FF7A1A" />
          <path d="M30 29 L35 17 L42 27 L49 14 L56 27 L63 17 L68 29 Z" fill="#FFB020" />
          <path d="M44 26 L49 16 L54 26 Z" fill="#FFD23F" />
        </g>
      );
    case "duke":
      return (
        <g>
          <path d="M21 31 Q17 12 39 9 Q49 7 60 10 Q81 14 78 31 Q71 19 61 18 L59 12 Q49 16 40 13 L37 19 Q28 18 21 31 Z" fill="#E9DFBC" />
          <path d="M38 13 Q43 5 51 9 Q46 12 44 17 Z" fill="#F4ECD0" />
          <path d="M40 13 Q47 11 55 13" stroke="#C9B273" strokeWidth={0.8} fill="none" />
          <path d="M25 27 Q31 20 41 19" stroke="#C9B273" strokeWidth={0.7} fill="none" />
          <path d="M60 26 Q66 21 73 24" stroke="#C9B273" strokeWidth={0.7} fill="none" />
        </g>
      );
    case "thriller":
      return (
        <g>
          <path d="M19 31 Q16 9 49 6 Q82 9 79 31 Q75 27 71 31 Q67 26 62 31 Q57 26 52 31 Q49 27 46 31 Q41 26 36 31 Q31 26 27 31 Q23 27 19 31 Z" fill="#191512" />
          <path d="M41 30 Q38 37 44 38 Q49 38 47.5 32 Q46 28 42.5 30 Z" fill="#191512" />
          <circle cx={29} cy={21} r={3} fill="#2a231d" opacity={0.55} />
          <circle cx={64} cy={19} r={3} fill="#2a231d" opacity={0.55} />
          <path d="M40 12 Q49 8 58 12" stroke="#3a322b" strokeWidth={0.8} fill="none" opacity={0.7} />
        </g>
      );
    case "moonwalk":
      return (
        <g transform="rotate(-8 49 20)">
          <ellipse cx={49} cy={23.5} rx={25} ry={5} fill="#F2EFE5" />
          <ellipse cx={49} cy={22.8} rx={25} ry={4.4} fill="#FFFFFF" />
          <path d="M34 23 Q33 7 49 5 Q65 7 64 23 Z" fill="#FCFAF2" />
          <path d="M42 8 Q49 6 56 8 L56 12 Q49 9.5 42 12 Z" fill="#E6E2D2" opacity={0.7} />
          <rect x={34} y={17} width={30} height={3.2} fill="#16171C" />
          <path d="M34 22.6 Q49 26.6 64 22.6" stroke="#D9D4C2" strokeWidth={0.6} fill="none" />
        </g>
      );
    case "conductor":
      return (
        <g>
          <ellipse cx={49} cy={22} rx={22} ry={4.5} fill="#0F2840" />
          <ellipse cx={49} cy={21.5} rx={21} ry={4} fill="url(#bnt-hat)" />
          <path d="M32 21Q32 10 49 7Q66 10 66 21Z" fill="url(#bnt-hat)" />
          <rect x={32} y={16.5} width={34} height={4.5} fill="#C9A84C" />
          <rect x={32} y={16.5} width={34} height={1.2} fill="#E8C864" opacity={0.5} />
          <circle cx={49} cy={13} r={4.5} fill="#C9A84C" />
          <circle cx={49} cy={13} r={3.2} fill="#1B3A5C" />
          <text x={49} y={15} textAnchor="middle" fontSize={4.5} fill="#E8C864" fontWeight="bold"
                fontFamily="var(--display)">JR</text>
        </g>
      );
  }
}

/** Bowie lightning face paint, Starman only. */
function FaceFx({ outfit }: { outfit: BonitoOutfit }) {
  if (outfit !== "starman") return null;
  return (
    <g>
      <path d="M57 26 L52 44 L58 43 L54 60 L64 41 L58 42 L63 26 Z" fill="#2BB3FF" opacity={0.25}
            transform="scale(1.18)" style={FILLBOX} />
      <path d="M57 26 L52 44 L58 43 L58 42 L63 26 Z" fill="#FF2E47" />
      <path d="M58 43 L54 60 L64 41 L58 42 Z" fill="#2BB3FF" />
      <path d="M57 26 L52 44 L58 43 L54 60" stroke="#fff" strokeWidth={0.5} fill="none" opacity={0.7} />
    </g>
  );
}

/* ---------------- the cat ---------------- */
export function Bonito({
  expression = "happy",
  outfit = "conductor",
  size = 272,
  bob = false,
  className,
}: {
  expression?: BonitoExpression;
  outfit?: BonitoOutfit;
  size?: number;
  /** Idle bob: on while music plays; off by default so he sits still in menus. */
  bob?: boolean;
  className?: string;
}) {
  const [blink, setBlink] = useState(false);

  // Auto-blink only when the expression uses the normal eye set.
  const blinkable = expression === "happy" || expression === "surprised" || expression === "curious";
  useEffect(() => {
    if (!blinkable) return;
    let t1: ReturnType<typeof setTimeout>, t2: ReturnType<typeof setTimeout>;
    let alive = true;
    const loop = () => {
      t1 = setTimeout(() => {
        if (!alive) return;
        setBlink(true);
        t2 = setTimeout(() => { setBlink(false); loop(); }, 130);
      }, 2200 + Math.random() * 2800);
    };
    loop();
    return () => { alive = false; clearTimeout(t1); clearTimeout(t2); setBlink(false); };
  }, [blinkable]);

  let eyes: React.ReactNode;
  let brows: React.ReactNode = null;
  if (blink && blinkable) {
    eyes = <BlinkEyes />;
  } else {
    switch (expression) {
      case "surprised": eyes = <NormalEyes sz={1.18} />; brows = <SurprisedBrows />; break;
      case "curious": eyes = <NormalEyes sz={1} />; brows = <CuriousBrows />; break;
      case "in-love": eyes = <HeartEyes />; break;
      case "star-struck": eyes = <StarEyes />; break;
      case "wink": eyes = <WinkEyes />; break;
      case "sleepy": eyes = <SleepyEyes />; break;
      default: eyes = <NormalEyes sz={1} />;
    }
  }
  const headTransform = expression === "curious" ? "rotate(-7 49 60)" : undefined;

  return (
    <svg
      className={`bonito ${bob ? "bnt-a-bob" : ""} ${className ?? ""}`}
      width={size}
      viewBox="0 0 100 115"
      style={{ display: "block", overflow: "visible" }}
      data-outfit={outfit}
      data-expression={expression}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="bnt-fur" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F4A940" /><stop offset="100%" stopColor="#E8922A" />
        </linearGradient>
        <linearGradient id="bnt-hat" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1B3A5C" /><stop offset="100%" stopColor="#2C5F8A" />
        </linearGradient>
        <linearGradient id="bnt-uniform" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#1B3A5C" /><stop offset="100%" stopColor="#15304D" />
        </linearGradient>
        <radialGradient id="bnt-blush">
          <stop offset="0%" stopColor="#FFB3B3" stopOpacity={0.7} />
          <stop offset="100%" stopColor="#FFB3B3" stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* ground shadow + tail */}
      <ellipse cx={49} cy={109} rx={30} ry={3.5} fill="#000" opacity={0.18} />
      <path d="M26 92Q12 82 8 68Q6 60 12 56" stroke="#F4A940" strokeWidth={5.5} fill="none" strokeLinecap="round" />
      <circle cx={12} cy={56} r={3.5} fill="#F7BC5E" />

      <Body outfit={outfit} />

      <g transform={headTransform}>
        {/* ears */}
        <path d="M22 28L18 2L38 22Z" fill="url(#bnt-fur)" stroke="#E8922A" strokeWidth={0.5} />
        <path d="M24 25L20.5 7L35 21Z" fill="#FFBBAA" />
        <path d="M76 28L80 2L60 22Z" fill="url(#bnt-fur)" stroke="#E8922A" strokeWidth={0.5} />
        <path d="M74 25L77.5 7L63 21Z" fill="#FFBBAA" />
        {/* face */}
        <path d="M20 32 Q16 40 18 50 Q20 58 28 62 Q36 66 49 66 Q62 66 70 62 Q78 58 80 50 Q82 40 78 32 Q72 24 49 22 Q26 24 20 32Z" fill="url(#bnt-fur)" />
        <ellipse cx={49} cy={50} rx={16} ry={12} fill="#F7BC5E" />
        <ellipse cx={49} cy={55} rx={9} ry={6} fill="#FCCF78" opacity={0.5} />
        <ellipse cx={27} cy={48} rx={6} ry={4} fill="url(#bnt-blush)" />
        <ellipse cx={71} cy={48} rx={6} ry={4} fill="url(#bnt-blush)" />
        {/* whiskers */}
        <path d="M10 42Q18 44 26 44" stroke="#D4802A" strokeWidth={0.8} fill="none" opacity={0.45} />
        <path d="M8 48Q17 48 26 48" stroke="#D4802A" strokeWidth={0.8} fill="none" opacity={0.45} />
        <path d="M11 54Q19 52 27 51" stroke="#D4802A" strokeWidth={0.8} fill="none" opacity={0.45} />
        <path d="M88 42Q80 44 72 44" stroke="#D4802A" strokeWidth={0.8} fill="none" opacity={0.45} />
        <path d="M90 48Q81 48 72 48" stroke="#D4802A" strokeWidth={0.8} fill="none" opacity={0.45} />
        <path d="M87 54Q79 52 71 51" stroke="#D4802A" strokeWidth={0.8} fill="none" opacity={0.45} />
        <path d="M46 46L49 48.5L52 46Z" fill="#FF8888" />

        <Headwear outfit={outfit} />
        {brows}
        {eyes}
        <Mouth expr={expression} />
        <FaceFx outfit={outfit} />
      </g>
    </svg>
  );
}
