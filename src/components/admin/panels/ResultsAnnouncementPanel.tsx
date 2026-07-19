// ⑦結果公告面板：sealed 且已有 result 草稿（開票流程自動生成，見 tally/actions.ts
// submitResults）時，直接載入該草稿到編輯器讓選委小編 → 發布結果公告。
// 這是「result」legalTag 唯一的可編輯 UI 入口——公告區塊的法定清單只顯示它的狀態，不重複放編輯器。
import { AlertTriangle } from "lucide-react";
import { AnnouncementEditor } from "@/components/admin/AnnouncementEditor";

export function ResultsAnnouncementPanel({
  electionId,
  status,
  resultsExist,
  resultAnnouncement,
}: {
  electionId: string;
  status: string;
  resultsExist: boolean;
  resultAnnouncement: { id: string; title: string; body: string; publishedAt: Date | null } | null;
}) {
  if (status !== "sealed" && status !== "published") {
    return (
      <p className="text-sm font-medium text-muted-foreground">
        尚未彌封／開票，無法發布結果公告。請先完成「⑤截止」與「⑥開票」。
      </p>
    );
  }

  if (!resultsExist || !resultAnnouncement) {
    return (
      <p className="text-sm font-medium text-muted-foreground">
        尚未在「⑥開票」面板提交計票結果，還沒有結果公告草稿可編輯。提交結果後系統會自動生成草稿於此。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {!resultAnnouncement.publishedAt && (
        <div className="flex items-start gap-2 rounded-xl border-2 border-foreground bg-tone-orange-bg p-3 text-tone-orange-text">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
          <p className="font-bold text-sm">
            發布後整場選舉結案（狀態變為「已公告結果」），公開結果頁對外可見，且無法回頭。發布前請確認內容無誤。
          </p>
        </div>
      )}
      <AnnouncementEditor
        electionId={electionId}
        id={resultAnnouncement.id}
        legalTag="result"
        legalTagLabel="結果公告"
        initialTitle={resultAnnouncement.title}
        initialBody={resultAnnouncement.body}
        publishedAt={resultAnnouncement.publishedAt}
      />
    </div>
  );
}
