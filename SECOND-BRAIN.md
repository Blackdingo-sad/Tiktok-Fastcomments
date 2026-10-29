# Second Brain

## _Case

Khách hàng mua hàng trong TikTok LIVE bằng cách bình luận giá/mã sản phẩm ngay sau khi người bán công bố. Khách hàng quan sát có người khác được hiển thị trước dù dường như gửi muộn hơn 0,4–0,6 giây, và nghi ngờ người đó dùng app riêng.

Đây là quan sát, chưa phải bằng chứng về app hay cơ chế ưu tiên. Cùng máy và mạng không bảo đảm thời điểm thao tác, đường đi request, trạng thái kết nối, xử lý phía dịch vụ hoặc thứ tự hiển thị giống nhau. Mục tiêu là giúp comments của khách hàng xuất hiện sớm hơn trên Tiktok live.

## _Tiến trình hiện tại

### Đã có trong code

- App desktop Electron trong `desktop/`: nhập username hoặc link LIVE, đăng nhập TikTok trong cửa sổ riêng, prewarm trạng thái kênh, soạn và gửi thủ công bằng Enter (Shift+Enter xuống dòng), hiển thị kết quả gửi và xác nhận echo.
- Backend Node/TypeScript trong `server/`: xác thực app token, kiểm tra dữ liệu, giới hạn tốc độ, quản lý phiên TikTok trong RAM, gửi bình luận, cache room ID và prewarm.
- Mặc định `SEND_PROVIDER=webcast`: gọi route Webcast trực tiếp từ connector với phiên TikTok; không cần API key Euler. `SEND_PROVIDER=euler` là tùy chọn relay qua Euler, cần API key/quyền của gói trả phí. Route Webcast trong project không đồng nghĩa với API chính thức hay cam kết ổn định của TikTok.
- `SEND_PROVIDER=browser`: mở Chrome thật qua `playwright-core` (`server/browser-launch.ts`), ghi cookie phiên trong RAM vào context rồi gõ bình luận vào ô chat của trang LIVE (`server/browser-send.ts`). Đây là đường không bị 403 vì chính trang TikTok ký request bằng SDK của họ. Gửi tuần tự để hai comment không tranh cùng ô nhập, giữ trang ấm giữa các lần gửi, mặc định `BROWSER_HEADLESS=0` để thấy cửa sổ. **Chưa gửi thật lần nào.**
- Đường browser được tối ưu cho một lần gửi nhanh: cửa sổ Chrome và trang LIVE mở sẵn qua `POST /api/rooms/prewarm` (app gọi khi đang nhập username), dùng lại đúng page đó cho các lần sau, gộp xuống dòng thành một dòng, và chỉ báo gửi thành công khi ô chat đã trống trở lại sau Enter. Ô chat còn chữ thì trả `browser_send_unconfirmed` thay vì báo thành công giả. Khi backend dừng, Chrome do provider mở cũng được đóng (`adapters.close()`). Nếu người vận hành tự đóng cửa sổ giữa chừng, lần `prepare` sau phát hiện mất kết nối và mở lại Chrome (đã kiểm bằng probe: đóng cửa sổ rồi gửi lại vẫn có page dùng được, không sót tiến trình).
- App có ô dán cookie thủ công (`sessionid` + `tt-target-idc`) cho trường hợp cửa sổ đăng nhập nhúng bị TikTok chặn; giá trị đi thẳng lên backend và bị xoá khỏi ô nhập ngay. `desktop/` có thêm `npm run pack` / `npm run dist` để đóng gói installer NSIS (chưa ký số).
- Gửi và xác nhận được tách riêng: backend trả lời sau khi provider chấp nhận; echo từ chat tới sau qua SSE. Timeout echo không chứng minh gửi thất bại và app không tự gửi lại.
- Đã có benchmark `send-benchmark.ts` (`npm run benchmark`) báo p50/p95/max cho `elapsedMs`, `providerMs`, `appearedMs`; lượt benchmark gửi nhiều bình luận và có thể công khai nội dung trên LIVE.
- `server/.env` bị Git ignore; không đưa API key, app token hoặc session cookie vào tài liệu/commit.

### Trạng thái kiểm chứng gần nhất

- Máy hiện dùng Node.js 22.13.0; Electron runtime có trong `desktop/node_modules`.
- Chạy lại trong phiên này: `npm run server:check` thành công; `npm run server:test` **56/56 test qua** (gồm 14 test cho `server/browser-send.ts`); `npm run check` trong `desktop/` thành công. `playwright-core` 1.64.1 đã cài và Chrome có ở đường dẫn mặc định của Windows. Worktree hiện còn thay đổi chưa commit (nhánh `main` vẫn bằng `origin/main`), nên không còn ở trạng thái sạch.
- Đo trên máy này: mở Chrome + ghi cookie ~0,63 s; tải `tiktok.com` tới `domcontentloaded` ~0,51 s; đóng cửa sổ ~0,14 s; `warmBrowser` qua adapter ~0,96 s; lần `prepare` thứ hai trả lại đúng page cũ và không còn tiến trình Chrome nào sau `close()`. Đây là chi phí khởi động, không phải độ trễ gửi.
- Test của provider `browser` dùng page giả ghi lại `goto`/`click`/`type`/`press`; không mở Chrome và không gửi gì lên TikTok. Chưa xác minh selector ô chat thật trên TikTok hiện tại, nên lần chạy LIVE đầu tiên vẫn là bước kiểm chứng bắt buộc.
- Chạy thật trên máy này (backend `SEND_PROVIDER=browser`, `SEND_DRY_RUN=0`, Windows): app nhận đúng `APP_TOKEN` từ `server/.env`, cửa sổ đăng nhập TikTok chia sẻ session của app nên đóng cửa sổ là backend nhận được phiên (`GET /api/session → configured`), và prewarm cho handle thật mở Chrome thật (8 tiến trình `chrome.exe` bật đúng lúc backend ghi `POST /api/rooms/prewarm`). Không gửi bình luận nào lên TikTok trong phiên này.
- Lỗi đã gặp và đã sửa: chạy backend với token demo trong khi app dùng token thật khiến mọi request trả 401, và app hiện "Không kết nối" dù backend vẫn sống. Giờ 401 hiện "Sai token" kèm hướng dẫn kiểm tra `APP_TOKEN`.
- Giao diện desktop được thiết kế lại (Hallmark, theme Vantage, phạm vi app screen, mức full): một cột dẫn bằng ô soạn bình luận, cấu hình tài khoản/backend gộp vào một dòng "Kết nối tài khoản và backend" có thể mở ra, và bảng đo từng chặng của lần gửi gần nhất nằm ngay dưới nút gửi, có vạch góc theo theme. `sloplint --scope app` báo 0 FAIL, 0 REFLEX, 0 WARN. Đã dựng lại installer (`desktop/release/LIVE Comment Desk Setup 1.0.0.exe`, 13:50) và kiểm tra `app.asar` chứa nội dung mới; chưa chạy GUI Electron thật sau khi đổi giao diện. Lưu ý: `desktop/release/win-unpacked` vẫn là bản cũ vì Windows khoá `app.asar` (không có tiến trình nào của app đang chạy); cần khởi động lại máy để xoá, installer thì đã đúng bản mới.
- Các test gửi trực tiếp Webcast dùng HTTP mock/canned response, không gửi request thật lên TikTok. Chưa xác minh gửi comment thật hoặc thứ tự hiển thị trên LIVE.
- Dry-run/backend GUI từng được kiểm thử trước đó theo ghi chú lịch sử; dry-run chỉ xác nhận luồng app/backend, không chứng minh TikTok nhận comment.
- Kiểm thử lại trên GUI trong phiên hiện tại với backend tạm chạy `SEND_DRY_RUN=1` và app token thử (không sửa `.env`): nút kiểm tra nhận HTTP 200; gửi từ app nhận HTTP 200 và `requestId`, báo `gõ → phản hồi 3 ms`, `renderer→main 0 ms`, `backend 0 ms`, `mạng 3 ms`. Backend log xác nhận request `dry-*`; không gọi TikTok.
- Kiểm thử GUI phát hiện lỗi đo `renderer→main` âm rất lớn do trừ `Date.now()` với `performance.now()`. Đã sửa ở `desktop/main.cjs` để dùng cùng đồng hồ tường cho mốc IPC; kiểm tra `npm run check` qua, GUI dry-run sau sửa cho giá trị không âm hợp lý.
- Đã có lần probe trước đó cho thấy lựa chọn Euler bị từ chối do cần quyền/add-on trả phí. Đây là blocker của provider Euler, không phải yêu cầu cho provider mặc định Webcast.
- Chưa xác nhận được TikTok login nhúng trên tài khoản thật, trạng thái LIVE thật, hay độ trễ end-to-end trong điều kiện bán hàng. Echo là best-effort; nếu không cấu hình `SENDER_UNIQUE_ID`, trùng nội dung có thể làm xác nhận không chắc chắn.
- `SECOND-BRAIN.md` trước merge bị dài và lỗi thời: ghi Euler trả phí như điều kiện bắt buộc, còn để phần “giải pháp đề xuất” như chưa triển khai, dùng tên công cụ đo sai và có số test cũ. Nội dung đã được thay bằng trạng thái hiện tại.

## _Ý tưởng hiện tại

1. Tiếp tục tối ưu phần app/backend có thể kiểm soát: giữ kết nối, tái sử dụng client, prewarm username/room trước lúc cần, cache room ID và gửi ngay khi người dùng xác nhận.
2. Thử theo từng bước với tài khoản của người vận hành và LIVE được phép kiểm thử: xác nhận login/session, kiểm tra `isLive`, gửi một bình luận có chủ đích, đối chiếu echo; không dùng benchmark nhiều lượt trên LIVE bán hàng nếu chưa được cho phép.
3. Ghi lại các mốc riêng: Enter→phản hồi, renderer→main, network/backend, provider acceptance và echo appearance. So sánh p50/p95 qua nhiều lượt trong điều kiện tương đương; không diễn giải `providerMs` hoặc echo như thời điểm TikTok hiển thị cho mọi người xem.
4. Chỉ cân nhắc Euler nếu cần relay và có quyền/gói phù hợp. Mặc định hiện tại không cần Euler API key, nhưng vẫn cần phiên TikTok hợp lệ; route Webcast có thể thay đổi hoặc bị TikTok từ chối.
5. Giữ gửi thủ công, tuân thủ chính sách và giới hạn nền tảng. Không tuyên bố có thể chen hàng, né kiểm soát hoặc bảo đảm thắng người gửi khác.

## _Việc tiếp theo

- Người vận hành kiểm tra đăng nhập TikTok bằng tài khoản của chính mình; xác nhận backend nhận phiên mà không ghi cookie ra đĩa.
- Khi có một LIVE thử nghiệm phù hợp, gửi số lượng nhỏ, có chủ đích; ghi điều kiện và số đo thực tế trước khi kết luận về tốc độ.
- Nếu tiếp tục sửa code, cập nhật mục tiến trình và kết quả kiểm thử tương ứng tại đây.

---

*(Gợi ý: **Case** = tình huống và điều chưa được chứng minh; **Tiến trình** = tính năng, bằng chứng kiểm thử và blocker; **Ý tưởng** = hướng cải thiện/đo lường; **Việc tiếp theo** = thao tác cần người vận hành hoặc bước kế tiếp.)*
