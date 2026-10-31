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
- `watch-live.ts` (`npm run watch`): màn hình observer đọc chat LIVE công khai, không cookie và không gửi comment. Chạy `npm run watch -- @live --sender @tai-khoan-gui` để bật đo đồng bộ với app: app gửi một marker chỉ chứa hash nội dung và timestamp qua loopback; observer ghép đúng tài khoản + nội dung và hiện `Δ ms` khi nhận được comment. Phải chạy trên cùng máy với app, cùng một LIVE và cổng 8787. Màn hình vẫn tô đậm/bíp theo từ khoá; `--demo` chỉ kiểm giao diện, không kiểm phép đo.
- Giao diện Android thiết kế lại theo Hallmark (app screen, tone soft): palette ấm khai báo trong `res/values/colors.xml`, ô soạn bình luận lên đầu, một nút chính, cài đặt đẩy xuống dưới, chữ sentence case, có trạng thái focus và disabled riêng. Xem mục kiểm chứng.
- App Android trong `android/`: APK đầu tiên dùng `AccessibilityService` để đặt nội dung vào ô bình luận LIVE của app TikTok thật rồi bấm gửi, không có ô trễ, không cần PC lẫn backend. Một lần bấm là một lần thử, không lặp, chỉ báo đã gửi khi ô chat trống lại. Giới hạn và mốc tiếp theo: `docs/ANDROID-APP-PLAN.md`.

### Trạng thái kiểm chứng gần nhất

- Phiên mới (30/10, máy khác máy ghi ở dòng dưới, Node v24.16.0): đã `npm install` lại (máy chưa có `node_modules`), chạy qua `npm run server:check` và `npm run server:test` **56/56 pass**. Tạo `server/.env` (APP_TOKEN sinh ngẫu nhiên, bị Git ignore) với `SEND_PROVIDER=browser`, `SEND_DRY_RUN=0`, `ECHO_CONFIRM=1`; backend chạy nền ở `http://127.0.0.1:3001`: `/health` → `dryRun:false, echo:true`, `/api/session` → `configured:false` (chưa có phiên TikTok). Đo stage 0 đúng theo flags của `server/browser-launch.ts` (Chrome thật, chưa có phiên, chỉ tải `tiktok.com`, không gửi gì): mở Chrome ~0,50 s, tải trang lần đầu ~1,87 s, lần hai ấm ~0,34 s, đóng ~0,83 s, không sót tiến trình `chrome.exe` — đây là chi phí khởi động, không phải độ trễ gửi. `watch-live --demo` trên cổng 8899 trả 200 và SSE có `state`/`chat`. **Chưa gửi bình luận nào; chưa có phiên TikTok và chưa có LIVE đích được phê duyệt.**
- Máy hiện dùng Node.js 22.13.0; Electron runtime có trong `desktop/node_modules`.
- Chạy lại trong phiên này: `npm run server:check` thành công; `npm run server:test` **56/56 test qua** (gồm 14 test cho `server/browser-send.ts`); `npm run check` trong `desktop/` thành công. `playwright-core` 1.64.1 đã cài và Chrome có ở đường dẫn mặc định của Windows. Nhánh `main` đã được đẩy lên `origin/main` (đầu mút `726512c`); worktree chỉ còn các thư mục scaffolding của agent (xem mục bàn giao), không còn thay đổi mã nguồn chưa commit.
- Đo trên máy này: mở Chrome + ghi cookie ~0,63 s; tải `tiktok.com` tới `domcontentloaded` ~0,51 s; đóng cửa sổ ~0,14 s; `warmBrowser` qua adapter ~0,96 s; lần `prepare` thứ hai trả lại đúng page cũ và không còn tiến trình Chrome nào sau `close()`. Đây là chi phí khởi động, không phải độ trễ gửi.
- Test của provider `browser` dùng page giả ghi lại `goto`/`click`/`type`/`press`; không mở Chrome và không gửi gì lên TikTok. Chưa xác minh selector ô chat thật trên TikTok hiện tại, nên lần chạy LIVE đầu tiên vẫn là bước kiểm chứng bắt buộc.
- Chạy thật trên máy này (backend `SEND_PROVIDER=browser`, `SEND_DRY_RUN=0`, Windows): app nhận đúng `APP_TOKEN` từ `server/.env`, cửa sổ đăng nhập TikTok chia sẻ session của app nên đóng cửa sổ là backend nhận được phiên (`GET /api/session → configured`), và prewarm cho handle thật mở Chrome thật (8 tiến trình `chrome.exe` bật đúng lúc backend ghi `POST /api/rooms/prewarm`). Không gửi bình luận nào lên TikTok trong phiên này.
- Lỗi đã gặp và đã sửa: chạy backend với token demo trong khi app dùng token thật khiến mọi request trả 401, và app hiện "Không kết nối" dù backend vẫn sống. Giờ 401 hiện "Sai token" kèm hướng dẫn kiểm tra `APP_TOKEN`.
- Giao diện desktop được thiết kế lại (Hallmark, theme Vantage, phạm vi app screen, mức full): một cột dẫn bằng ô soạn bình luận, cấu hình tài khoản/backend gộp vào một dòng "Kết nối tài khoản và backend" có thể mở ra, và bảng đo từng chặng của lần gửi gần nhất nằm ngay dưới nút gửi, có vạch góc theo theme. `sloplint --scope app` báo 0 FAIL, 0 REFLEX, 0 WARN. Đã dựng lại installer (`desktop/release/LIVE Comment Desk Setup 1.0.0.exe`, 13:50) và kiểm tra `app.asar` chứa nội dung mới; chưa chạy GUI Electron thật sau khi đổi giao diện. Lưu ý: `desktop/release/win-unpacked` vẫn là bản cũ vì Windows khoá `app.asar` (không có tiến trình nào của app đang chạy); cần khởi động lại máy để xoá, installer thì đã đúng bản mới.
- Các test gửi trực tiếp Webcast dùng HTTP mock/canned response, không gửi request thật lên TikTok. Chưa xác minh gửi comment thật hoặc thứ tự hiển thị trên LIVE.
- Dry-run/backend GUI từng được kiểm thử trước đó theo ghi chú lịch sử; dry-run chỉ xác nhận luồng app/backend, không chứng minh TikTok nhận comment.
- Giao diện Android (30/10): dựng lại và xem trên emulator ở 3 trạng thái: bật dịch vụ, ô soạn đang focus (viền terracotta), dịch vụ tắt (nút gửi màu cát, nhãn "Chưa bật" màu cảnh báo). Chữ nhãn không còn viết hoa toàn bộ; nhãn nút gửi khi disabled đổi màu để còn đọc được. Chưa xem trên máy thật, chưa có dark mode (app luôn nền sáng).
- `watch-live.ts` (30/10): `tsc` qua; chạy `--demo` trên cổng 8801 trả trang 200, SSE có frame `state` và `chat`, comment "giá 199k" được đánh dấu khớp cả "199k" và "gia"; handle không tồn tại thoát với thông báo rõ nguyên nhân. Chưa chạy với LIVE thật nên chưa xác minh kết nối chat thật.
- Chế độ đo hai client: app đóng dấu lúc Enter thật được nhấn sau độ trễ chọn; `watch-live` là observer thứ hai trong cùng LIVE và ghép bằng username người gửi + hash nội dung. Đã kiểm endpoint và ghép marker/comment ở demo, không kết nối TikTok và không gửi comment thật. Timestamp được ghi ở độ phân giải mili-giây, nhưng kết quả chỉ là từ Enter đến lúc connector observer nhận event, không phải lúc TikTok phân phối/render cho mọi người xem. 31/10: đã chạy observer (chỉ đọc) với một LIVE thật phát từ TikTok LIVE Studio (`@mehideslow`) — kết nối được và comment của chính chủ phòng, gõ trong ô chat của LIVE Studio, có hiện trong feed chat public mà observer đọc (5 comment trong ~4 phút). LIVE Studio không phát marker lúc Enter nên không có `Δ` cho comment gửi từ đó, và chưa có số tốc độ nào; muốn có số thì phải quay màn hình đếm khung hình, chỉ chính xác tới khoảng 1 khung.
- APK Android (30/10): `./gradlew assembleDebug` qua, APK ký debug, cài và mở trên emulator `Medium_Phone_API_37.0` không crash, `dumpsys accessibility` xác nhận service được bind; bấm Gửi ngay trả `tiktok_not_foreground` vì emulator không có TikTok. Chưa kiểm trên máy thật và chưa gửi bình luận nào. Lần kiểm này tìm ra lỗi: điều kiện "service đang bật" so sánh chuỗi nên không nhận dạng được dạng viết tắt `pkg/.Service`; đã sửa bằng `ComponentName`.
- Kiểm thử lại trên GUI trong phiên hiện tại với backend tạm chạy `SEND_DRY_RUN=1` và app token thử (không sửa `.env`): nút kiểm tra nhận HTTP 200; gửi từ app nhận HTTP 200 và `requestId`, báo `gõ → phản hồi 3 ms`, `renderer→main 0 ms`, `backend 0 ms`, `mạng 3 ms`. Backend log xác nhận request `dry-*`; không gọi TikTok.
- Bổ sung run record ngày 31/10 (do người vận hành báo lại, chưa có raw output/backend log để kiểm chứng độc lập): 3 `POST /api/comments` vào `@chimsedinang` khi `SEND_DRY_RUN=1`; `backendMs` được báo p50≈0 ms, p95≈1 ms, max≈1 ms. Không gửi bình luận lên TikTok; `providerMs=null`, không có echo/`appearedMs` và không đo được `Δ ms`. Trong code hiện tại, nhánh dry-run trả về trước tra cứu room ID và provider, nên không ghi số này thành “room-cache latency”; đây chỉ là thời gian xử lý local server, 3 mẫu quá ít để suy ra p95 ổn định. Chi tiết/provenance: `docs/SPEED-TEST.md`.
- Lệnh observer trong ví dụ `npm run watch -- @live-handle --sender @sender-account` dùng handle mẫu; run report không có kết nối LIVE/match. `npm run watch` tại checkout này chạy `node --import tsx watch-live.ts`, UI cục bộ mặc định cổng 8787. Listener cục bộ không đồng nghĩa observer đã kết nối TikTok; observer cũng không dùng session của backend gửi.
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

## _Quy trình đo để giải case_

Case chỉ giải được ở phần mình đo được: ghi lại thời điểm từng chặng trong đường gửi của mình, rồi so với đường nền gửi tay trên Chrome mở sẵn. Quan sát "người kia hiện trước 0,4–0,6 giây" bằng mắt chưa phải số đo, và không cách nào đọc được hàng đợi hay mức ưu tiên của TikTok. Mục tiêu là xác định chặng nào mình đang mất thời gian và rút được bao nhiêu, không phải chứng minh ai được ưu tiên.

### Cái gì được đo

Mỗi lần gửi tách thành các chặng, mỗi chặng một mốc thời gian riêng:

1. Gõ xong → renderer ghi mốc (bảng chặng nằm ngay dưới nút gửi).
2. renderer → main (IPC) → backend: thời gian backend nhận request.
3. backend → provider: `providerMs`, thời gian provider chấp nhận gửi.
4. Echo: `appearedMs`, thời gian bình luận quay lại kênh chat của phòng — mốc "hiện ra" gần nhất mình có, best-effort.

Không dùng một con số tổng: mỗi chặng so riêng với đường nền gửi tay để biết khoảng cách nằm ở đâu.

### Dùng công cụ gì

- Bảng chặng trong app desktop: ghi mốc của lần gửi gần nhất, không cần chạy lệnh riêng.
- `npx tsx measure-live.ts <handle|link LIVE> --count 5 --interval 3000 --text "..." --yes`: gửi số lượng nhỏ qua backend đang chạy, in ack p50/p95 và `appearedMs` p50/p95; tự thoát với lý do rõ ràng nếu `SEND_DRY_RUN=1`, echo tắt, thiếu phiên TikTok hoặc kênh không LIVE.
- `npm run benchmark` (`send-benchmark.ts`) cho nhiều lượt hơn — chỉ chạy khi LIVE đích và nội dung đã được phê duyệt.
- `npm run watch -- @live --sender @tai-khoan-gui` (`watch-live.ts`) là client observer thứ hai cho cùng LIVE. Khi app desktop chạy cùng máy, các comment của tài khoản được chỉ định hiện thêm `Δ ms` từ lúc Enter được nhấn đến lúc observer nhận event. Observer không gửi comment; không chạy trên LIVE bán hàng nếu chưa được cho phép.
- Log backend và SSE `/api/comments/events` để đối chiếu với số đo phía client.

### Các bước

1. **Khóa điều kiện:** app gửi và observer chạy trên cùng máy, cùng một LIVE; dùng username người gửi đúng như chat hiển thị. Không dùng hai phòng LIVE khác nhau để so thứ tự.
2. **Chạy observer trước:** `npm run watch -- @live --sender @tai-khoan-gui`; xác nhận trang ở `http://127.0.0.1:8787/` báo đang theo dõi LIVE.
3. **Mở app và vào cùng LIVE:** đăng nhập tài khoản của người vận hành, để app mở trang LIVE. Chưa có phép đo nếu observer không hiện badge `Δ ms`.
4. **Chỉ gửi nội dung thử đã được duyệt:** một lần gửi thủ công qua app; app ghi mốc ngay trước khi nhấn Enter sau độ trễ đã chọn. Không chạy benchmark nhiều lượt trên LIVE bán hàng.
5. **Đọc kết quả:** `Δ ms` là Enter→observer nhận event. Có thể xem thứ tự các event trên observer, nhưng không diễn giải nó là thời gian mọi khán giả nhìn thấy hoặc vị trí hàng đợi.
6. **Ghi điều kiện và kết quả**; dừng nếu TikTok trả 403/429, không tự động gửi lại.

### Giới hạn của cách đo này

- `appearedMs` là thời điểm bình luận của mình hiện ra, không phải vị trí hàng đợi; không nói được bình luận người khác đến sớm hay muộn hơn.
- `Δ ms` của observer dùng đồng hồ hệ thống cùng máy và độ phân giải mili-giây; độ chính xác thực tế còn phụ thuộc thời điểm connector phát event, mạng và xử lý/hiển thị trên client. Nó không đo được mốc xử lý nội bộ hoặc thời điểm mọi người xem nhận comment.
- Ghép marker trong 30 giây theo username + nội dung chuẩn hoá; nếu chính tài khoản đó gửi cùng nội dung nhiều lần sát nhau thì có thể ghép nhầm. Không có badge `Δ` nghĩa là chưa ghép được, không phải chắc chắn gửi thất bại.
- Echo best-effort: hết echo không chứng minh gửi thất bại.
- So với người gửi khác chỉ làm được bằng quan sát trên cùng màn hình và timecode, với sai số của mắt và của đồng hồ đo; con số 0,4–0,6 giây trong case chưa qua công cụ nào.
- Không đo trên LIVE bán hàng khi chưa được phép, và không đo để tối ưu việc chen hàng.

## _Việc tiếp theo

- Người vận hành kiểm tra đăng nhập TikTok bằng tài khoản của chính mình; xác nhận backend nhận phiên mà không ghi cookie ra đĩa.
- Khi có một LIVE thử nghiệm phù hợp, gửi số lượng nhỏ, có chủ đích; ghi điều kiện và số đo thực tế trước khi kết luận về tốc độ.
- Nếu tiếp tục sửa code, cập nhật mục tiến trình và kết quả kiểm thử tương ứng tại đây.

## _Bàn giao cho phiên AI tiếp theo_

### Mốc hiện tại

- `main` và `origin/main` trùng nhau tại commit mới nhất của nhánh; kiểm nhanh bằng `git status -sb` (không nên thấy `ahead`). Commit mã cuối cùng là `726512c` — `fix(desktop): say "sai token" when the backend refuses the token`; các commit sau đó chỉ sửa tài liệu.
- 6 commit mã trong lần đẩy này đều đã qua kiểm tra trước khi đẩy: `server:check`, `server:test` **56/56 pass**, `desktop/npm run check`; các commit sau đó chỉ sửa tài liệu.
- Worktree chỉ còn file chưa track là scaffolding công cụ của agent (`.agents/`, `.claude/`, `.hallmark/`, `skills-lock.json`). Đây không phải mã sản phẩm; đừng commit nếu không được yêu cầu.

### 6 commit trong lần đẩy này, theo thứ tự

1. `6c876cc` — thêm provider `SEND_PROVIDER=browser`: mở LIVE bằng Chrome thật qua `playwright-core`, gõ vào ô chat để TikTok tự ký request (lý do: route Webcast trả 403 khi request không do SDK của họ ký). Cửa sổ do prewarm mở sớm, đóng khi backend dừng, mở lại nếu người vận hành đóng tay; chỉ báo thành công khi ô chat trống lại. Lỗi của TikTok giờ trả kèm status và lý do thay vì 502 trống. File chính: `server/browser-launch.ts`, `server/browser-send.ts`, `server/live.ts`.
2. `aafa8bb` — dựng lại console desktop quanh luồng gửi: hai cột, in từng chặng của lần gửi dưới ô soạn, ô dán cookie thủ công, script đóng gói NSIS, sửa lỗi số đo `renderer→main` âm do trộn `Date.now()` với `performance.now()`, và prewarm lại sau khi đăng nhập.
3. `4536262` — ghi lại số đo của đường Chrome (~0,6 s mở, ~0,5 s tải trang, ~0,15 s đóng) và thêm `measure-live.ts` báo thời gian Enter→xuất hiện.
4. `a614922` — đưa ô soạn bình luận lên làm trọng tâm, gộp cấu hình tài khoản/backend vào một dòng gập "Kết nối tài khoản và backend".
5. `338608a` — sửa nhãn trạng thái còn viết hoa và bỏ dấu chấm giữa dòng meta (chỉ đổi chữ).
6. `726512c` — 401 từ backend trước đây hiện "Không kết nối" (khiến người vận hành đi kiểm tra server đang chạy tốt); giờ báo "Sai token" và chỉ vào `APP_TOKEN` trong `server/.env`.

### Đọc gì trước

1. `AGENTS.md` → bắt buộc đọc `docs/COMMENT-SEND-LATENCY.md` trước khi sửa đường gửi comment, browser automation, provider hoặc claim về độ trễ.
2. `docs/COMMENT-SEND-LATENCY.md` — quyết định thiết kế và giới hạn bằng chứng hiện hành.
3. File này (`SECOND-BRAIN.md`) — trạng thái, bằng chứng, blocker.
4. `server/browser-send.ts`, `server/live.ts`, `desktop/renderer.js` — nơi phần lớn thay đổi gần đây nằm.
5. `android/README.md` — nếu phiên sau làm gì với APK Android: đọc file này trước, nói rõ nó là gì và **chưa gửi được bình luận** (thiếu nút nổi M1), rồi mới tiếp tục.

### Lệnh kiểm tra (đã chạy được trên máy này, Windows + Node 22.13.0)

- `npm run server:check` — typecheck server.
- `npm run server:test` — 56 test, gồm test provider browser; dùng page giả, không mở Chrome, không gọi TikTok.
- `cd desktop && npm run check` — kiểm cú pháp `main.cjs`, `preload.cjs`, `renderer.js`.
- `npm run benchmark` và `measure-live.ts` **gửi bình luận thật**; không chạy nếu chưa được cho phép.

### Điều chưa được chứng minh (đừng ghi như đã xong)

- Chưa có lần gửi thật nào qua provider `browser` lên LIVE, nên selector ô chat thật và độ trễ Enter→xuất hiện vẫn chưa xác minh.
- Chưa chạy GUI Electron thật sau lần đổi giao diện; installer đã dựng lại và `app.asar` đã kiểm, nhưng `desktop/release/win-unpacked` còn là bản cũ vì Windows khoá file.
- Echo chat là best-effort, không phải mốc thời gian hiển thị cho mọi người xem.
- Không kết luận app nhanh hơn Chrome thủ công cho một comment; xem lý do trong `docs/COMMENT-SEND-LATENCY.md`.

### Ràng buộc

- Không đưa API key, `APP_TOKEN` hay session cookie vào tài liệu, log hoặc commit. `server/.env` bị Git ignore.
- Không thêm spoofing chữ ký/fingerprint, xoay proxy/IP, giải CAPTCHA hay né rate limit.
- Không gửi comment thật hay chạy benchmark nhiều lượt khi chưa có phê duyệt rõ ràng cho LIVE đích và nội dung chính xác.

---

*(Gợi ý: **Case** = tình huống và điều chưa được chứng minh; **Tiến trình** = tính năng, bằng chứng kiểm thử và blocker; **Ý tưởng** = hướng cải thiện/đo lường; **Quy trình đo để giải case** = cái gì được đo, dùng công cụ gì và các bước để ra số; **Việc tiếp theo** = thao tác cần người vận hành hoặc bước kế tiếp.)*
