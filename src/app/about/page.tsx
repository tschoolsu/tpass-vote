// 透明性說明頁：免登入可看，白話說明投票怎麼保密、殘餘風險是什麼，並附 GitHub 連結
// 供公開監督。內容對齊 README.md 的「防護邊界（誠實版）」表，但寫給非技術選民看。
import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, RefreshCcw, ShieldCheck, Eye, AlertTriangle } from "lucide-react";
import { PublicShell } from "@/components/public/Shell";
import { GithubMark } from "@/components/public/GithubMark";
import { Card } from "tpass-ui";
import { tpass } from "@/config/auth";
import { isAdmin } from "@/config/admin";
import { GITHUB_URL } from "@/config/site";

export const metadata: Metadata = {
  title: "關於 T-Vote｜投票怎麼保密",
  description: "白話說明 T-Vote 的雙信封加密投票機制、匿名性保障與殘餘風險，並附原始碼連結供公開監督。",
};

export default async function AboutPage() {
  const session = await tpass.getSession();
  const admin = isAdmin(session);

  return (
    <PublicShell isLoggedIn={session !== null} isAdmin={admin} wide>
      <span className="inline-flex items-center gap-1.5 rounded-md border-2 border-foreground bg-card px-2 py-0.5 font-mono text-[11px] font-bold shadow-[2px_2px_0_0_var(--color-foreground)]">
        <ShieldCheck className="h-3.5 w-3.5" /> 透明性說明
      </span>
      <h1 className="mt-4 font-extrabold text-3xl sm:text-4xl tracking-tight">
        關於 T-Vote：投票怎麼保密
      </h1>
      <p className="mt-2 max-w-2xl font-medium text-muted-foreground">
        這頁用白話說明系統怎麼保護你的投票內容、怎麼讓你能反悔重投，以及誠實列出它做不到的事。
        看不懂技術也沒關係，重點都寫在每一段的第一句。
      </p>

      <div className="mt-8 flex flex-col gap-5">
        <Card>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-foreground bg-primary text-primary-foreground shadow-[2px_2px_0_0_var(--color-foreground)]">
              <KeyRound className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-extrabold text-lg">你的選票在你的手機／電腦裡就先上鎖</h2>
              <p className="mt-2 font-medium text-foreground/80">
                按下「送出選票」的那一刻，你的選擇會先在<strong>你自己的瀏覽器裡</strong>
                被加密鎖起來，變成一串連我們自己都打不開的亂碼，之後才送到伺服器。伺服器收到的
                從頭到尾只有這串亂碼，從來沒看過你真正選了誰。這就像投票時先把選票放進一個上鎖
                的信封，再把信封投進票匭——差別是這道鎖是數學鎖，鑰匙也不在管委員手上（見下一段）。
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-foreground bg-accent text-primary-foreground shadow-[2px_2px_0_0_var(--color-foreground)]">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-extrabold text-lg">開票鑰匙不在伺服器上，選委才有</h2>
              <p className="mt-2 font-medium text-foreground/80">
                每場選舉開始前，選舉委員會的人會在自己電腦上產生一組「開票鑰匙」，下載成檔案
                自己保管（也可以拆成兩份，各給一位選委分開收好，開票時兩份都要有才能解鎖，
                避免一人說了算）。伺服器只拿到能「上鎖」的那一半（公鑰），從來沒拿到能「解鎖」
                的那一半。所以就算伺服器整台被入侵、資料庫整包外流，攻擊者拿到的也只是一堆
                打不開的亂碼，看不到任何人投給誰。
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-foreground bg-tone-green-badge text-tone-green-text shadow-[2px_2px_0_0_var(--color-foreground)]">
              <RefreshCcw className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-extrabold text-lg">投票截止前，你可以隨時換裝置重投，以最後一次為準</h2>
              <p className="mt-2 font-medium text-foreground/80">
                系統只記錄「你投過」這件事（一人一格），不記錄「你投了幾次」。每次重投都會直接
                覆蓋你上一次的選擇，只有最後一次會被計票，之前投的內容會被蓋掉、不會被看到、
                也不會重複計票。這是刻意設計的：如果有人在校內看著你投票、逼你選特定人，你可以
                回家後換一台裝置、用同一個帳號重新投一次真正想投的人，脅迫就失效了。
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-foreground bg-tone-violet-badge text-tone-violet-text shadow-[2px_2px_0_0_var(--color-foreground)]">
              <Eye className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-extrabold text-lg">開票時，「你是誰」跟「你投什麼」會先被拆開</h2>
              <p className="mt-2 font-medium text-foreground/80">
                投票截止後，系統會把所有加密選票「彌封」：拿掉每張票原本的身分標記、把票的順序
                打亂重新排列，變成一份公開、任何人都能重新驗算的票匭快照。選委再用開票鑰匙在自己
                電腦上解鎖、算出票數。因為身分標記在彌封那一步就被拿掉、順序也被打亂，即使是拿著
                開票鑰匙的人，也還原不出「這張解密後的選票原本是誰投的」。
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-foreground bg-destructive text-primary-foreground shadow-[2px_2px_0_0_var(--color-foreground)]">
              <AlertTriangle className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-extrabold text-lg">誠實說：這套機制做不到的事</h2>
              <p className="mt-2 font-medium text-foreground/80">
                如果<strong>拿著開票鑰匙的選委，同時又跟能操作資料庫的系統管理員互相勾結</strong>，
                理論上是可能兩邊資料對照、還原出誰投了什麼——這是任何「可跨裝置重投＋確保匿名」
                的投票系統在數學上都繞不開的極限，不是我們沒做好。我們的緩解方式是<strong>職權分離</strong>
                ：開票鑰匙只在選舉委員會手上（可拆成兩份分別保管），資料庫只有維運人員能碰，
                兩邊平時互不重疊。這跟紙本選舉「兩位監票員聯手也能做票」的信任模型是一樣的，
                差別只是我們把這件事寫在這裡讓所有人知道，而不是假裝完全不會發生。
              </p>
              <p className="mt-2 text-sm font-medium text-muted-foreground">
                投票收據只能證明「你投過」，不能證明你投了什麼——所以沒辦法拿收據去邀功、也沒辦法
                被人拿收據逼你證明投給誰。開票後，任何人都能用票匭快照重新驗算票數，確認沒有多出來
                的幽靈票。
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-foreground bg-foreground text-[oklch(0.99_0_0)] shadow-[2px_2px_0_0_var(--color-primary)]">
              <GithubMark className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-extrabold text-lg">原始碼公開，歡迎檢查我們有沒有說謊</h2>
              <p className="mt-2 font-medium text-foreground/80">
                以上說的每一件事，都可以直接對照原始碼驗證——加密怎麼做、伺服器存了什麼欄位、
                彌封怎麼洗牌，程式碼都是公開的。發現任何跟上面說明不一致的地方，歡迎回報。
              </p>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-2 rounded-xl border-2 border-foreground bg-card px-4 py-2 font-bold text-foreground shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-foreground)]"
              >
                <GithubMark className="h-4 w-4" />
                查看 GitHub 原始碼
              </a>
            </div>
          </div>
        </Card>
      </div>

      <p className="mt-8 text-sm font-medium text-muted-foreground">
        <Link href="/" className="font-bold text-accent hover:underline">
          ← 回首頁
        </Link>
      </p>
    </PublicShell>
  );
}
