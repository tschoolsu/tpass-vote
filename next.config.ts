import type { NextConfig } from "next";

// 全站安全標頭。選舉系統被 iframe 嵌進釣魚頁、或被誘導點擊，代價是選票——所以
// frame-ancestors / X-Frame-Options 這條不是可有可無的加分項。
// CSP 只設 frame-ancestors：Next 的 RSC payload 需要 inline script，完整 CSP 要配 nonce
// middleware，那是另一件事，不在這裡半套上路（半套的 CSP 只會讓人誤以為有防護）。
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  // 不對外宣告用什麼框架跑：省不了多少事，但也沒有理由主動送給掃描器。
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
