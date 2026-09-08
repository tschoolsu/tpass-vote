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
        這頁用白話說明系統怎麼保護你的投票內容、為什麼連資料庫裡都查不到你投了什麼，
        以及誠實列出它做不到的事。看不懂技術也沒關係，重點都寫在每一段的第一句。
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
              <h2 className="font-extrabold text-lg">每人只能投一次，送出後就不能改了</h2>
              <p className="mt-2 font-medium text-foreground/80">
                名冊上只會記「你投過了」這一格，連你是什麼時候投的都不記——因為記了時間，
                就有辦法拿投票的先後順序去跟票匭裡的票排排看、把票對回人。也因為只能投一次，
                系統會在你按下送出<strong>之前</strong>先把你的「可回溯代碼」顯示出來，請務必先抄下來：
                那是開票後查詢自己那一票唯一的憑據，投完就不能再投一次換一組新的。
                如果不小心投錯了，選委會也沒辦法幫你重設——這是為了讓「誰投了什麼」這件事
                在資料庫裡從一開始就不存在，付出的代價。
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
              <h2 className="font-extrabold text-lg">「你是誰」跟「你投什麼」從一開始就沒有被連在一起</h2>
              <p className="mt-2 font-medium text-foreground/80">
                你的票存進資料庫時，那一列<strong>沒有任何欄位指得回你</strong>——沒有姓名、沒有帳號、
                沒有編號，連時間都沒有。系統只在名冊上另外把你那格勾成「已投票」，兩邊完全不相連。
                投票截止後還會再「彌封」一次：把所有票的順序打亂重排，變成一份公開、任何人都能
                重新驗算的票匭快照，原本的暫存整張刪掉。選委再用開票鑰匙在自己電腦上解鎖、算出票數。
                所以就算是拿著開票鑰匙的人，也還原不出「這張解密後的選票原本是誰投的」。
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
                第一，<strong>沒有反悔的機會</strong>。如果有人在旁邊盯著你投票、逼你選特定人，
                你事後沒有任何辦法改回真正想投的。舊版可以換裝置重投來化解脅迫，但那個做法的代價是
                資料庫得一直留著「這張票是誰的」，我們選了另一邊。
              </p>
              <p className="mt-2 font-medium text-foreground/80">
                第二，<strong>在投票進行中就能翻資料庫的人</strong>，還是有機會把一小部分的票對回人。
                資料庫內部會記下「每一列是哪一次寫入動作留下的」，而勾選名冊跟放進票匭是同一次動作。
                我們的對策有兩層：每收一張票就順手改寫十幾筆不相干的資料當煙霧；投票一截止，再把
                整場的名冊與票匭全部重寫一次，讓所有紀錄看起來都出自同一個動作——這一步之後，
                <strong>連這條線索都完全消失</strong>。所以真正還有風險的只有「投票正在進行的那幾天，
                而且他就守在資料庫前面」，我們估算那樣大約能對上百分之一點五的人。防線因此是職權分離：
                開票鑰匙只在選舉委員會手上（可拆成兩份分別保管），資料庫只有維運人員能碰，兩邊平時
                互不重疊，而且投票期間不得對正式資料庫下手動查詢。這跟紙本選舉「兩位監票員聯手也能
                做票」的信任模型是一樣的，差別只是我們把這件事寫在這裡讓所有人知道，而不是假裝
                完全不會發生。
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
