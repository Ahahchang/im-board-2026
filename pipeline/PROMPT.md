# 每日更新流程（排程任務執行）

排程任務要掛上兩個 repo：`im-board-2026`（公開網站）和 `im-board-2026-raw`（私人，GitHub Actions 每天 02:15 轉好的講義）。不需要 token，也絕不把任何金鑰寫進檔案或 commit。

1. 兩個 repo 都拉到最新：`git pull`。
2. 讀 raw repo 的 `state.json`（每份講義的 `name`、`folder`、`modifiedTime`、`pages`），它已排除 (1) 副本與「2026影片」資料夾。
3. 跟公開 repo 的 `data/manifest.json` 比對：
   - state.json 有、manifest 沒有，或 `modifiedTime` 比 manifest 的 `drive_modified` 新 → 需要（重新）整理。
   - manifest 有、state.json 已經沒有 → 刪除對應 `data/notes/<id>.md` 和 `data/img/<id>/`。
   - 「詳解」資料夾的檔案（例如 114年內專詳解.pdf）不整理成講義，只用來比對考古題。
4. 每個需要整理的講義：讀 raw repo 的 `text/<id>.json`（每頁文字）並看 `pages/<id>/<n>.webp`（每頁圖片），依 `pipeline/NOTE_FORMAT.md` 產生 `data/notes/<id>.md`。
   - 考古題：講義自己的標註，加上比對「詳解」資料夾那份檔案的 `text/<id>.json`。
   - 考題附圖與臨床影像：從對應頁面圖裁切，存成 `data/img/<id>/<流水號>.webp`。
   - 若該講義已存在，保留原 category（使用者的手動分類存在 Firestore，前端會優先採用）。
   - 小標名稱盡量沿用舊版，讓「我的弱點」星號不會失效。
5. 執行 `python3 scripts/build.py`，失敗就修正筆記格式直到通過。
6. 沒有任何變更就結束，不要 commit。有變更就 commit（訊息列出新增／更新／刪除的講義）並 push；GitHub Pages 會自動重新部署。
7. 回報：新增、更新、刪除了哪些講義。
