# Second Brain

## _Case

Khách hàng mua hàng trong TikTok LIVE bằng cách bình luận giá/mã sản phẩm ngay sau khi người bán công bố. Khách hàng quan sát có người khác được hiển thị trước dù dường như gửi muộn hơn 0,4–0,6 giây, và nghi ngờ người đó dùng app riêng.

Đây là quan sát, chưa phải bằng chứng về app hay cơ chế ưu tiên. Cùng máy và mạng không bảo đảm thời điểm thao tác, đường đi request, trạng thái kết nối, xử lý phía dịch vụ hoặc thứ tự hiển thị giống nhau. Mục tiêu là giúp comments của khách hàng xuất hiện sớm hơn trên Tiktok live.

## _Tiến trình hiện tại

### Đã có trong code

- App desktop Electron trong `desktop/`: nhập username hoặc link LIVE, đăng nhập TikTok trong cửa sổ riêng, prewarm trạng thái kênh, soạn và gửi thủ công bằng Enter (Shift+Enter xuống dòng), hiển thị kết quả gửi và xác nhận echo.
- Backend Node/TypeScript trong `server/`: xác thực app token, kiểm tra dữ liệu, giới hạn tốc độ, quản lý phiên TikTok trong RAM, gửi bình luận, cache room ID và prewarm.
- Mặc định `SEND_PROVIDER=webcast`: gọi route Webcast trực tiếp từ connector với phiên TikTok; không cần API key Euler. `SEND_PROVIDER=euler` là tùy chọn relay qua Euler, cần API key/quyền của gói trả phí. Route Webcast trong project không đồng nghĩa với API chính thức hay cam kết ổn định của TikTok.
- Gửi và xác nhận được tách riêng: backend trả lời sau khi provider chấp nhận; echo từ chat tới sau qua SSE. Timeout echo không chứng minh gửi thất bại và app không tự gửi lại.
- Đã có benchmark `send-benchmark.ts` (`npm run benchmark`) báo p50/p95/max cho `elapsedMs`, `providerMs`, `appearedMs`; lượt benchmark gửi nhiều bình luận và có thể công khai nội dung trên LIVE.
- `server/.env` bị Git ignore; không đưa API key, app token hoặc session cookie vào tài liệu/commit.

### Trạng thái kiểm chứng gần nhất

- Máy hiện dùng Node.js 24.16.0; Electron runtime có trong `desktop/node_modules`.
- Chạy lại trong phiên này: `npm run server:check` thành công; `npm run server:test` **43/43 test qua**; `npm run check` trong `desktop/` thành công. Trước khi sửa tài liệu này, worktree sạch và `git diff --check` không báo lỗi.
- Các test gửi trực tiếp Webcast dùng HTTP mock/canned response, không gửi request thật lên TikTok. Chưa xác minh gửi comment thật hoặc thứ tự hiển thị trên LIVE.
- Dry-run/backend GUI từng được kiểm thử trước đó theo ghi chú lịch sử; dry-run chỉ xác nhận luồng app/backend, không chứng minh TikTok nhận comment.
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
