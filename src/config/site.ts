// 靜態站台常數：跟 SSO/網域/DB 不同，這些值不會因環境而變，不走 env。
export const GITHUB_URL = "https://github.com/tschoolsu/tpass-vote";

// 學校所在時區，是事實不是部署參數（正式主機時區是 UTC，不代表選舉時間該用 UTC 理解）。
// datetime-local 的解析／回填與所有時間顯示都以此為準，不依賴 server 的 process TZ。
export const SITE_TIMEZONE = "Asia/Taipei";
