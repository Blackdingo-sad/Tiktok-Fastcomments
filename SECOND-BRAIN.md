# Second Brain

## _Case

Khách hàng mua hàng trong TikTok LIVE bằng cách bình luận giá/mã sản phẩm ngay khi người bán công bố. Khách hàng cho biết có người khác vẫn được hiển thị trước dù dường như gửi muộn hơn khoảng 0,4–0,6 giây, và nghi ngờ người đó dùng app riêng.

Đây hiện là quan sát, chưa phải kết luận kỹ thuật. Dùng chung máy và mạng không chứng minh hai bình luận được nhập, gửi, nhận hoặc sắp thứ tự giống nhau. Khác biệt có thể đến từ thời điểm thao tác, độ trễ giao diện/đường truyền, xử lý của dịch vụ, đồng bộ đồng hồ hoặc cách người xem nhìn thấy chat. Chưa có dữ liệu xác nhận app kia tồn tại hay TikTok ưu tiên bình luận của app đó.

Mục tiêu hợp lý: giúp người dùng gửi bình luận thủ công nhanh hơn và đo từng chặng có thể quan sát được. Không hứa giành thứ tự trước người khác: app không kiểm soát thứ tự xử lý/phân phối của TikTok và không có cơ chế ưu tiên được xác nhận.

## _Tiến trình hiện tại

### Đã có

- Ứng dụng desktop Electron trong `desktop/`: nhập username, soạn bình luận, gửi bằng Enter (Shift+Enter xuống dòng), báo trạng thái và thời gian phản hồi.
- Backend Node/TypeScript trong `server/`, dùng route gửi được connector hỗ trợ; thông tin Euler và cookie TikTok chỉ cấu hình ở backend qua `server/.env`.
- Chế độ thử `SEND_DRY_RUN=1`, kiểm tra token đầu vào, nội dung, giới hạn tốc độ gửi, timeout và xử lý lỗi.
- Giữ kết nối HTTP, tái sử dụng connector, cache room ID và prewarm room/luồng theo dõi trước khi cần gửi.
- Trả kết quả sau khi provider nhận yêu cầu; theo dõi bình luận xuất hiện riêng qua SSE để không chờ xác nhận mới hoàn tất thao tác gửi.
- README có hướng dẫn chạy và hợp đồng API. Kiểm tra gần nhất (Node 24.16.0): `npm run server:check`, `npm run server:test` (26 test) và `npm run check` trong `desktop/` đều qua.
- Chuyển máy phát triển sang Node 24.16.0 qua `nvm use 24.16.0` (đạt yêu cầu desktop ≥ 22.12); Electron 45.0.0 đã cài đầy đủ kèm `dist/electron.exe`.
- Sửa script `server` trong `package.json` thành `node --import tsx --env-file-if-exists=server/.env server/index.ts`: trước đây README hướng dẫn copy `server/.env` nhưng không có gì đọc file đó nên backend luôn từ chối khởi động.
- Đã tạo `server/.env` từ mẫu với `SEND_DRY_RUN=1` và `APP_TOKEN` ngẫu nhiên 48 ký tự (`.env` nằm trong `.gitignore`, không commit).
- Đã chạy dry-run end-to-end với backend thật đang chạy: 10/10 kiểm tra hợp đồng HTTP (health 200, sai token 401, thiếu token 401, validate 400, gửi hợp lệ 200 với `requestId` `dry-*`, gửi liên tiếp 429, prewarm 2xx, SSE không token 401, route sai 404/405); round-trip ~2 ms, `providerMs=null`.
- Đã khởi chạy giao diện desktop bằng `npm start` (4 tiến trình `electron.exe`, không lỗi khởi động).
- Đã kiểm tra đường đọc với TikTok thật bằng `live-link-check.ts` (chạy `npx tsx live-link-check.ts`): với handle `mtien0044` lấy được roomId `7701346099785255698` sau ~0,5 s mà không cần đăng nhập (scrape trang chính thất bại → tự fallback sang API, hai thông báo error đó là fallback vô hại); `isLive=false` nên chưa xem được chat, script giữ lại để chạy lại khi kênh LIVE.
- **Phiên TikTok nhận lúc chạy:** backend có `GET/PUT /api/session` (Bearer token), giữ phiên chỉ trong RAM (`server/session.ts`), áp lại cookie jar trước mỗi lần gửi; cấu hình thật giờ chỉ bắt buộc `EULER_API_KEY`, thiếu phiên khi gửi → `409 session_missing`.
- **Nhận cả link LIVE:** backend và desktop tự trích handle từ `https://www.tiktok.com/@username/live`; link của trang khác vẫn bị từ chối 400.
- **Trạng thái LIVE:** `prewarm` trả `{ ok, isLive }` (adapter `fetchIsLive`, không cần đăng nhập) và app hiển thị badge `ĐANG LIVE` / `OFFLINE` cạnh ô nhập.
- **Cửa sổ đăng nhập TikTok trong app:** IPC `tiktok:login` mở BrowserWindow riêng (chỉ được điều hướng trong tiktok.com, chặn popup OAuth — dùng email/mật khẩu hoặc mã QR); sau khi người dùng đóng cửa sổ, main process đọc `sessionid` + `tt-target-idc` từ cookie jar rồi PUT lên backend — renderer không bao giờ chạm cookie.
- Kiểm tra gần nhất (Node 24.16.0): `npm run server:check` + `npm run server:test` **33/33 test** (thêm 7 test mới: URL, session, isLive), `npm run check` trong `desktop/` qua; e2e dry-run với backend đang chạy **12/12** (session GET/PUT/401/405/400, gửi bằng link LIVE, prewarm `isLive:null`, rate limit 429); Electron chạy lại sạch (4 tiến trình, không lỗi), 17 ID renderer đều khớp HTML.
- **Gửi bình luận không còn phụ thuộc gói Euler trả phí:** route mới `SendRoomChatWebcastRoute` (`src/lib/web/routes/send-room-chat-webcast.ts`) POST thẳng `webcast/room/chat/` (fallback `webcast/comment/publish/`) tới TikTok bằng cookie phiên của tài khoản gửi — không API key, không gửi qua dịch vụ trung gian; chỉ ký request best-effort khi TikTok trả 401/403. `sendMessage()` chọn đường gửi qua option `sendProvider` (mặc định `'webcast'`, `'euler'` giữ nguyên đường trả phí cũ). Backend có biến `SEND_PROVIDER` (mặc định `webcast`) và **không còn bắt buộc `EULER_API_KEY`** — chỉ yêu cầu key khi `SEND_PROVIDER=euler`. Nhờ vậy một máy phát triển không cần tài khoản Euler vẫn chạy được.
- Kiểm thử sau thay đổi: `npm run server:check` và `npx tsc -p tsconfig.json --noEmit` (thư viện) đều qua; `npm run server:test` **43/43 test** (thêm `server/send-chat.test.ts`: POST đúng path/param/cookie, thiếu `tt-target-idc`, session hết hạn 20003, lỗi nghiệp vụ, fallback 404 → `comment/publish`, 2xx không có `status_code`, chọn `sendProvider`; sửa test cấu hình: chế độ thật không còn yêu cầu Euler key).
- **Benchmark độ trễ đường gửi:** script `send-benchmark.ts` ở gốc repo (`npm run benchmark`, thêm `-- runs/--gap/--unique/--content/--no-echo`) lặp lại `POST /api/comments` và báo p50/p95/max cho `elapsedMs`, `backendMs`, `providerMs`, `appearedMs` (echo SSE), tự prewarm phòng trước, giữ `--gap` theo `SEND_MIN_INTERVAL_MS` và thoát mã 1 khi có run lỗi/429. Đã chạy thử với backend dry-run: 4/4 run ~2–4 ms (p50 2.0, p95 4.0), 429 được đếm đúng khi `--gap 200`; cờ `--no-echo` và cột provider/echo hiện n/a ở dry-run. Script đo pipeline của mình, không đo độ trễ hiển thị của TikTok.
- **Phân chia độ trễ theo từng chặng ở client:** `POST /api/comments` giờ trả thêm `backendMs` (thời gian backend xử lý trong handler gửi), renderer ghi lại thời điểm Enter (`clientSentAtMs`) và gửi kèm qua IPC; main tính `ipcMs` (renderer→main), `responseMs`, `requestEnqueuedAtMs`/`receivedAtMs`. Kết quả hiển thị: `gõ → phản hồi` · `renderer→main` · `mạng` (= `responseMs − backendMs`) · `backend` · `provider`; chặng `gõ → phản hồi` cũng giữ lại ở dòng kết quả echo. Đã kiểm bằng: `node --check` desktop, `server:check` + `server:test` 43/43 (thêm assert `backendMs`), smoke renderer bằng DOM giả (Enter → submit có `clientSentAtMs`, thông điệp chứa đủ 4 chặng, echo giữ chặng) và benchmark thật với backend dry-run (cột `backendMs` p50 0.0/p95 1.0 ms).

### Còn thiếu hoặc cần xác minh

- Chưa chạy thử end-to-end với tài khoản được phép gửi và TikTok LIVE đang hoạt động: `server/.env` mới chỉ có giá trị dry-run, chưa điền `TIKTOK_SESSION_ID`, `TIKTOK_TT_TARGET_IDC` (với `SEND_PROVIDER=webcast` mặc định thì không cần `EULER_API_KEY` nữa). Chế độ thử không gửi bình luận lên TikTok.
- **Chưa xác minh trên TikTok thật:** endpoint `webcast/room/chat/` (và `webcast/comment/publish/`) còn nhận POST trực tiếp chưa, và TikTok có bắt buộc chữ ký (X-Bogus/msToken) cho gửi bình luận hay không. Nếu cả hai bị từ chối, phương án dự phòng là gửi từ trong cửa sổ đăng nhập TikTok của Electron (fetch trong trang tiktok.com, dùng cookie + ký sẵn của trang).
- Benchmark mới chạy ở chế độ thử; chưa có số liệu `providerMs`/`appearedMs` với backend gửi thật, nên chưa so sánh được với mức <0,6 s mà người dùng thao tác tay đạt được.
- Chia chặng client-side chưa được kiểm tra trong cửa sổ Electron thật (chỉ smoke ở DOM giả): cần mở app, gửi thử và đọc dòng kết quả để chắc hiển thị đủ các chặng.
- Chưa đo hoặc chứng minh được app cải thiện thời gian bình luận thực sự xuất hiện; thời gian request/provider không đồng nghĩa thời gian hiển thị.
- Chưa có thử nghiệm đối chứng đủ tin cậy để giải thích chênh lệch 0,4–0,6 giây hoặc xác nhận app khác có thể vượt thứ tự.
- Xác nhận echo hiện là best-effort. Nếu không cấu hình `SENDER_UNIQUE_ID`, trùng nội dung từ người khác có thể làm kết quả xác nhận không chắc chắn.
- Electron đã khởi chạy được, nhưng mới kiểm tra qua HTTP trực tiếp; chưa tương tác trong GUI (nhập backend URL + token, gõ username, gửi Enter) để xác nhận app gửi dry-run từ đầu đến cuối.
- Chưa thử **đăng nhập TikTok thật** trong cửa sổ nhúng: cần người thao tác; TikTok có thể hiện captcha/chặn trong webview, và OAuth popup (Google/Apple) bị chặn chủ động — nếu bị chặn thì chuyển sang cách dán cookie thủ công (chưa có ô dán trong app).
- Cookie có thể xoay sau khi đăng nhập; app chỉ bắt lại khi mở lại cửa sổ đăng nhập, chưa có cơ chế làm mới tự động. Chưa đặt `SENDER_UNIQUE_ID` nên xác nhận echo vẫn best-effort.
- Badge trạng thái LIVE đã có trong app nhưng mới kiểm ở dry-run (`isLive:null`); chưa đối chiếu với trạng thái thật của kênh trong lúc gửi.
- Chưa đóng gói thành installer Windows. Backend hiện thiết kế cho một người vận hành và mặc định bind `127.0.0.1`; chưa triển khai dịch vụ HTTPS công khai.

## _Ý tưởng hiện tại

1. **Đo trước khi kết luận:** chạy nhiều lượt trong LIVE thử nghiệm được phép. Ghi thời điểm nhấn gửi bằng đồng hồ monotonic, thời gian provider nhận, và thời điểm echo xuất hiện; báo p50/p95. So sánh baseline với app trên cùng tài khoản, thiết bị, mạng và điều kiện gần tương đương.
2. **Giảm phần chờ do ứng dụng kiểm soát:** giữ phiên backend và kết nối HTTP, prewarm username/room trước lúc cần, dùng cache room ID, gửi ngay khi người dùng xác nhận. Đây là tối ưu phần nhập và đường đi ứng dụng–backend, không phải tăng quyền ưu tiên ở TikTok.
3. **Tách gửi khỏi xác nhận:** phản hồi ngay khi provider chấp nhận; hiển thị kết quả echo sau đó. Không tự gửi lại khi timeout vì yêu cầu có thể đã tới nơi.
4. **Hoàn tất kiểm chứng thực tế:** nâng Node lên 22.12+, chạy desktop, xác nhận `npm start`, kiểm tra dry-run, rồi mới thử LIVE thật bằng tài khoản của khách hàng và quyền gửi hợp lệ. Ghi lại lỗi, độ trễ và điều kiện thử.
5. **Giữ giới hạn sử dụng:** gửi thủ công, tuân thủ chính sách và giới hạn nền tảng/provider. Không tìm cách chen hàng, né rate limit/moderation hoặc ghi trực tiếp qua WebSocket nội bộ chưa được hỗ trợ; không thể bảo đảm app sẽ bình luận trước người khác.

## _Giải pháp đề xuất: cho app mượn tài khoản TikTok

Bài toàn: gửi bình luận thì **nhất thiết phải có phiên đăng nhập** (dù gửi HTTP thủ công); đọc chat thì không. Ai có session đó thì bình luận xuất hiện bằng tài khoản đó. Các phương án, từ ít code đến nhiều:

1. **Giữ nguyên `server/.env` (đã hoạt động):** người vận hành tự lấy cookie `sessionid` + `tt-target-idc` từ trình duyệt (DevTools → Application → Cookies) rồi điền vào `.env`, khởi động lại backend. Ít code nhất, một tài khoản cố định, xoay session phải restart.
2. **Ô nhập phiên trong app desktop:** thêm trường sessionid + tt-target-idc (hoặc dán một lần), gửi lên backend qua kênh đã xác thực (Bearer token), backend giữ **chỉ trong RAM** (không ghi đĩa, đúng quy tắc “không lưu bí mật” hiện có) và áp cho connector qua `cookieJar.setSession()` lúc chạy. Backend thêm endpoint kiểu `PUT /api/session`. Nhiều tài khoản được, không cần sửa `.env`, nhưng người dùng vẫn phải tự Cop cookie.
3. **Cửa sổ đăng nhập TikTok nhúng trong Electron (UX tốt nhất):** mở trang đăng nhập TikTok thật trong BrowserWindow; người dùng tự nhập mật khẩu/2FA (app không thấy credential), sau login app đọc `sessionid` và `tt-target-idc` từ cookie jar của Electron rồi gửi lên backend trong RAM. Không phải hướng dẫn Cop cookie, tự làm mới cookie khi xoay; đổi lại là phần việc lớn nhất và cần tôn trọng điều khoản TikTok (chỉ đăng nhập tài khoản của chính người dùng, không tự động hóa spam).
4. **QR-code login:** đẹp hơn nhưng nhiều thành phần, không lợi hơn phương án 3 đủ để ưu tiên.

Kèm theo (nhỏ, nên làm song song): cho app **nhận cả URL LIVE** (`https://www.tiktok.com/@xxx/live` → tự tách handle) và cho backend báo **trạng thái LIVE của kênh đích** (đã chứng minh `fetchIsLive()` chạy không cần đăng nhập, ~0,7 s) trước khi người dùng gửi.

**Đã chọn phương án 3 (cửa sổ đăng nhập nhúng) + 2 bổ sung nhỏ (nhận link LIVE và badge trạng thái LIVE) và triển khai xong phần code** — xem mục “Đã có” để biết chi tiết và bằng chứng kiểm thử. Còn lại khi thử thật: xác nhận TikTok cho đăng nhập trong webview, xử lý xoay cookie, và đặt `SENDER_UNIQUE_ID` để xác nhận echo khớp đúng bình luận của mình.

## Quy tắc cập nhật

Mỗi khi thay đổi code, kiến trúc, cấu hình, kết quả test hoặc phát hiện blocker, cập nhật mục tương ứng ở đây. Phân biệt rõ điều đã triển khai, điều đã kiểm thử bằng mock/dry-run và điều đã xác minh trên TikTok thật.

---

*(Gợi ý nội dung: **Case** = tình huống và điều chưa được chứng minh; **Tiến trình** = đã làm, còn thiếu và blocker; **Ý tưởng** = hướng triển khai/kiểm chứng cùng giới hạn; **Quy tắc cập nhật** = luôn ghi lại thay đổi và bằng chứng.)*
