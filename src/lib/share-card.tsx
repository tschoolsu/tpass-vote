// 候選人分享圖：連結預覽（1200×630，opengraph-image）與 IG 限動直式圖（1080×1920，story route）。
// 兩張圖畫的是同一份資料，版型各自一個元件；這裡只有 satori 吃得懂的 inline style。
//
// 幾個 satori（next/og 底層）的限制，改版型前先知道：
// - 不認 oklch，顏色寫死成 tpass-ui theme.css 換算出來的 hex（見 C）。
// - 內建字型只有拉丁字母，中文要自己帶：assets/fonts 是 Noto Sans CJK TC 切成 CJK 基本區＋Big5 的
//   TrueType（產生方式見 assets/fonts/build-subset.py）。擴充區的字不在裡面，會被補成別的字重。
// - 圖只吃 PNG/JPEG/SVG。大頭照允許上傳 webp，那種就退回姓名首字的佔位圓。
import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import QRCode from "qrcode";
import { prisma } from "@/lib/db";
import { getObject } from "@/lib/storage";
import { SITE_TIMEZONE } from "@/config/site";
import { candidateDisplayName, plainExcerpt } from "@/components/public/shared";
import { candidatePageUrl, type PublicCandidateData } from "@/lib/public-candidate";

const C = {
  bg: "#fbfcfd",
  fg: "#16181d",
  card: "#ffffff",
  primary: "#20a04e",
  accent: "#1a83db",
  muted: "#f0f2f4",
  mutedFg: "#60636a",
  greenBadge: "#a2ecb1",
  blueBg: "#def5ff",
};

const FONT_FAMILY = "Noto Sans TC";

let fontsPromise: Promise<[Buffer, Buffer]> | null = null;

export async function shareCardFonts() {
  fontsPromise ??= Promise.all([
    readFile(join(process.cwd(), "assets/fonts/NotoSansTC-Black.ttf")),
    readFile(join(process.cwd(), "assets/fonts/NotoSansTC-Bold.ttf")),
  ]);
  const [black, bold] = await fontsPromise;
  return [
    { name: FONT_FAMILY, data: black, weight: 900 as const, style: "normal" as const },
    { name: FONT_FAMILY, data: bold, weight: 700 as const, style: "normal" as const },
  ];
}

// ── 已算好的圖快取 ─────────────────────────────────────────────────────
// 這兩條路徑不用登入，一張圖要吃掉幾百 ms CPU 與幾十 MB 暫存；被連點或被 LINE/IG 的
// 爬蟲同時抓時，不能每次都重畫（2026-09-02 事故就是 RSS 撞線後 pm2 重啟迴圈）。
// 合法的鍵只有「核准候選人 × 兩種版型」，數量很小，Map 加 TTL 就夠，不需要 LRU。
// 鍵帶 updatedAt：候選人資料改了就自然換鍵，不必等 TTL。
const RENDER_TTL_MS = 5 * 60_000;
const RENDER_MAX_ENTRIES = 64;
const rendered = new Map<string, { at: number; png: Promise<ArrayBuffer> }>();

export function renderCached(key: string, render: () => Promise<Response>): Promise<ArrayBuffer> {
  const now = Date.now();
  const hit = rendered.get(key);
  if (hit && now - hit.at < RENDER_TTL_MS) return hit.png;

  if (rendered.size >= RENDER_MAX_ENTRIES) {
    for (const [k, v] of rendered) if (now - v.at >= RENDER_TTL_MS) rendered.delete(k);
    if (rendered.size >= RENDER_MAX_ENTRIES) rendered.clear();
  }

  // 存 promise 而不是結果：同一張圖同時被要好幾次時只畫一次。畫失敗就丟掉，下次重來。
  const png = render().then((res) => res.arrayBuffer());
  png.catch(() => rendered.delete(key));
  rendered.set(key, { at: now, png });
  return png;
}

// ── 資料 ──────────────────────────────────────────────────────────────

interface CardPhoto {
  src: string | null;
  initial: string;
}

export interface ShareCard {
  electionTitle: string;
  number: number;
  name: string;
  platform: string;
  photos: CardPhoto[];
  votingLine: string | null;
  urlLabel: string;
  qr: string;
}

const CARD_IMAGE_MIME = new Set(["image/jpeg", "image/png"]);

async function photoDataUri(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const upload = await prisma.upload.findUnique({
    where: { id },
    select: { kind: true, mime: true, storageKey: true },
  });
  // 跟 /api/photos/[id] 同一條邊界：只有 kind === "photo" 的檔可以公開出現在圖上。
  if (!upload || upload.kind !== "photo" || !CARD_IMAGE_MIME.has(upload.mime)) return null;
  const body = await getObject(upload.storageKey);
  return body ? `data:${upload.mime};base64,${body.toString("base64")}` : null;
}

async function qrDataUri(url: string): Promise<string> {
  const svg = await QRCode.toString(url, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
    color: { dark: C.fg, light: C.card },
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** 10/28（二）08:00 */
function formatShort(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("zh-TW", {
      timeZone: SITE_TIMEZONE,
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.month}/${parts.day}（${parts.weekday.replace("週", "")}）${parts.hour}:${parts.minute}`;
}

export async function loadShareCard(data: PublicCandidateData): Promise<ShareCard> {
  const { election, candidate } = data;
  const url = candidatePageUrl(election.slug, candidate.number);
  const [photos, qr] = await Promise.all([
    Promise.all(
      candidate.members.map(async (m) => ({
        src: await photoDataUri(m.photo),
        initial: m.name.trim().slice(0, 1) || "?",
      })),
    ),
    qrDataUri(url),
  ]);
  return {
    electionTitle: election.title,
    number: candidate.number,
    name: candidateDisplayName(election.kind, candidate.members),
    platform: candidate.platform,
    photos,
    votingLine:
      election.votingStartsAt && election.votingEndsAt
        ? `投票 ${formatShort(election.votingStartsAt)} – ${formatShort(election.votingEndsAt)}`
        : null,
    urlLabel: url.replace(/^https?:\/\//, ""),
    qr,
  };
}

// ── 版型 ──────────────────────────────────────────────────────────────

/** 依字數縮字級：聯名的「甲 ・ 乙（副手）」會長到十幾個字，不縮就爆版。 */
function nameSize(name: string, sizes: [number, number, number, number]): number {
  const len = name.length;
  if (len <= 4) return sizes[0];
  if (len <= 7) return sizes[1];
  if (len <= 12) return sizes[2];
  return sizes[3];
}

function Photo({ photo, size }: { photo: CardPhoto; size: number }) {
  const ring = Math.round(size / 40);
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: size,
        border: `${ring}px solid ${C.fg}`,
        boxShadow: `${ring * 2}px ${ring * 2}px 0 0 ${C.fg}`,
        background: C.muted,
        overflow: "hidden",
        fontSize: size * 0.42,
        fontWeight: 900,
        color: C.mutedFg,
      }}
    >
      {photo.src ? (
        // eslint-disable-next-line @next/next/no-img-element -- satori 只認原生 img。
        <img src={photo.src} alt="" width={size} height={size} style={{ objectFit: "cover" }} />
      ) : (
        photo.initial
      )}
    </div>
  );
}

function NumberBadge({ n, fontSize }: { n: number; fontSize: number }) {
  const unit = Math.round(fontSize / 10);
  return (
    <div
      style={{
        display: "flex",
        alignSelf: "flex-start",
        padding: `${unit}px ${unit * 3}px`,
        borderRadius: unit * 2,
        border: `${unit}px solid ${C.fg}`,
        boxShadow: `${unit}px ${unit}px 0 0 ${C.fg}`,
        background: C.primary,
        color: C.card,
        fontSize,
        fontWeight: 900,
      }}
    >
      {`${n} 號`}
    </div>
  );
}

function Brand({ fontSize }: { fontSize: number }) {
  return (
    <div style={{ display: "flex", fontSize, fontWeight: 900, color: C.fg }}>
      T<span style={{ color: C.primary }}>-</span>Vote
    </div>
  );
}

export function OgCard({ card }: { card: ShareCard }) {
  const photoSize = card.photos.length > 1 ? 210 : 330;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        gap: 56,
        padding: "56px 64px",
        background: C.bg,
        fontFamily: FONT_FAMILY,
        border: `12px solid ${C.fg}`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        {card.photos.map((p, i) => (
          <Photo key={i} photo={p} size={photoSize} />
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 22 }}>
        <div style={{ display: "flex", fontSize: 30, fontWeight: 700, color: C.mutedFg }}>
          {card.electionTitle}
        </div>
        <NumberBadge n={card.number} fontSize={40} />
        <div
          style={{
            display: "flex",
            fontSize: nameSize(card.name, [104, 84, 64, 52]),
            fontWeight: 900,
            color: C.fg,
            lineHeight: 1.15,
          }}
        >
          {card.name}
        </div>
        <div style={{ display: "flex", fontSize: 28, fontWeight: 700, color: C.fg, lineHeight: 1.5 }}>
          {plainExcerpt(card.platform, 56)}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontSize: 26, fontWeight: 900, color: C.primary }}>
            {card.votingLine ?? ""}
          </div>
          <Brand fontSize={34} />
        </div>
      </div>
    </div>
  );
}

export function StoryCard({ card }: { card: ShareCard }) {
  const photoSize = card.photos.length > 1 ? 400 : 560;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "96px 80px 88px",
        background: C.bg,
        fontFamily: FONT_FAMILY,
        border: `16px solid ${C.fg}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Brand fontSize={52} />
        <div
          style={{
            display: "flex",
            padding: "10px 24px",
            borderRadius: 16,
            border: `5px solid ${C.fg}`,
            background: C.blueBg,
            fontSize: 34,
            fontWeight: 900,
            color: C.fg,
          }}
        >
          {card.electionTitle}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 48, marginTop: 80 }}>
        {card.photos.map((p, i) => (
          <Photo key={i} photo={p} size={photoSize} />
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 28, marginTop: 72 }}>
        <NumberBadge n={card.number} fontSize={64} />
        <div
          style={{
            display: "flex",
            fontSize: nameSize(card.name, [148, 120, 88, 72]),
            fontWeight: 900,
            color: C.fg,
            lineHeight: 1.1,
          }}
        >
          {card.name}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          marginTop: 48,
          padding: "40px 44px",
          borderRadius: 32,
          border: `6px solid ${C.fg}`,
          boxShadow: `14px 14px 0 0 ${C.fg}`,
          background: C.card,
        }}
      >
        <div style={{ display: "flex", fontSize: 34, fontWeight: 900, color: C.accent }}>政見</div>
        <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color: C.fg, lineHeight: 1.6 }}>
          {plainExcerpt(card.platform, 90)}
        </div>
      </div>

      <div style={{ display: "flex", flex: 1 }} />

      {card.votingLine && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginBottom: 40,
            padding: "16px 24px",
            borderRadius: 20,
            border: `5px solid ${C.fg}`,
            background: C.greenBadge,
            fontSize: 36,
            fontWeight: 900,
            color: C.fg,
          }}
        >
          {card.votingLine}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 44 }}>
        <div
          style={{
            display: "flex",
            padding: 20,
            borderRadius: 24,
            border: `6px solid ${C.fg}`,
            background: C.card,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- satori 只認原生 img。 */}
          <img src={card.qr} alt="" width={230} height={230} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1 }}>
          <div style={{ display: "flex", fontSize: 54, fontWeight: 900, color: C.fg }}>掃碼看完整政見</div>
          <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: C.mutedFg }}>
            {card.urlLabel}
          </div>
        </div>
      </div>
    </div>
  );
}
