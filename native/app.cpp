#include "accessibility.hpp"
#include "platform.hpp"
#include <algorithm>
#include <cmath>
#include <commctrl.h>
#include <condition_variable>
#include <d2d1.h>
#include <dwmapi.h>
#include <dwrite.h>
#include <map>
#include <shellapi.h>
#include <thread>
#include <windowsx.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;
using namespace overlay;
namespace {
constexpr UINT model_message = WM_APP + 1, tray_message = WM_APP + 2, show_message = WM_APP + 3;
constexpr UINT expand_id = 101, collapse_id = 102, refresh_id = 103, hide_id = 104;
constexpr UINT tray_visibility = 201, tray_pin = 202, tray_login = 203, tray_refresh = 204, tray_quit = 205;
constexpr wchar_t window_class[] = L"CodexTokenOverlayNative";
struct App {
    HWND hwnd{}, tooltip{};
    std::vector<HWND> buttons;
    NOTIFYICONDATAW tray{};
    HICON icon{};
    std::wstring title, tooltip_text;
    fs::path profile;
    bool test = false, fixture = false, expanded = false, quitting = false;
    float scale = 1;
    int extra_offset = 0;
    POINT last_mouse{-1, -1};
    Store store;
    Json state, view;
    std::string connection = "connecting", error;
    std::mutex mutex;
    std::condition_variable wake;
    std::atomic_bool stopped{false};
    bool dirty = false, refresh_requested = false;
    std::thread worker;
    ComPtr<ID2D1Factory> factory;
    ComPtr<IDWriteFactory> text_factory;
    ComPtr<ID2D1HwndRenderTarget> target;
    ComPtr<ID2D1SolidColorBrush> brush;
    std::map<int, ComPtr<IDWriteTextFormat>> fonts;
    struct Line {
        ComPtr<ID2D1PathGeometry> geometry;
        D2D1_COLOR_F color;
        bool forecast;
    };
    std::vector<Line> lines;
    struct Mark {
        float x, y;
        Json point;
        bool forecast;
    };
    std::vector<Mark> marks;
    double chart_ceiling = 100;
    Millis chart_start = 0, chart_reset = 0;
    App(fs::path path, bool isolated)
        : profile(std::move(path)), test(isolated),
          fixture(isolated && environment(L"CODEX_OVERLAY_E2E_FIXTURE") == L"1"),
          store(profile / L"quota-state.json") {
        state = store.load();
        expanded = state["settings"]["expanded"];
        view = snapshot(state, connection, error, now());
        title = L"Codex Token Overlay | " + wide(sha256(utf8(fs::absolute(profile).wstring())).substr(0, 16));
    }
    ~App() {
        stopped = true;
        wake.notify_all();
        if (worker.joinable())
            worker.join();
        if (tray.hWnd)
            Shell_NotifyIconW(NIM_DELETE, &tray);
        if (icon)
            DestroyIcon(icon);
    }
    void notify() {
        if (hwnd)
            PostMessageW(hwnd, model_message, 0, 0);
    }
    void run_service() {
        worker = std::thread([this] {
            Server server(stopped);
            ULONGLONG next = 0;
            unsigned retry = 0;
            while (!stopped) {
                bool refresh = false;
                {
                    std::lock_guard lock(mutex);
                    refresh = std::exchange(refresh_requested, false);
                }
                try {
                    bool event = false;
                    if (!fixture && server.pid())
                        event = server.changed();
                    if (refresh || event || GetTickCount64() >= next) {
                        if (!fixture && !server.running())
                            server.start(find_codex());
                        Json buckets;
                        if (!fixture)
                            buckets = parse_limits(server.request("account/rateLimits/read"));
                        {
                            std::lock_guard lock(mutex);
                            if (!fixture)
                                state["rateLimits"] = std::move(buckets);
                            state["rateLimitsSyncedAt"] = iso(now());
                            observe(state, now());
                            connection = "online";
                            error.clear();
                            dirty = true;
                        }
                        next = GetTickCount64() + 60000;
                        retry = 0;
                        notify();
                    }
                } catch (const std::exception &failure) {
                    server.stop();
                    if (stopped)
                        break;
                    {
                        std::lock_guard lock(mutex);
                        connection = "offline";
                        error = failure.what();
                    }
                    next = GetTickCount64() + std::min(60000u, 2000u * (1u << std::min(retry++, 5u)));
                    notify();
                }
                Json pending;
                {
                    std::lock_guard lock(mutex);
                    if (dirty) {
                        pending = state;
                        dirty = false;
                    }
                }
                if (!pending.is_null())
                    try {
                        store.save(pending);
                    } catch (const std::exception &failure) {
                        std::lock_guard lock(mutex);
                        error = failure.what();
                        connection = "offline";
                        notify();
                    }
                std::unique_lock lock(mutex);
                wake.wait_for(lock, std::chrono::milliseconds(500),
                              [this] { return stopped || dirty || refresh_requested; });
            }
            server.stop();
            Json final_state;
            {
                std::lock_guard lock(mutex);
                final_state = state;
            }
            try {
                store.save(final_state);
            } catch (const std::exception &failure) {
                OutputDebugStringW(wide(failure.what()).c_str());
            }
        });
    }
    void set_setting(const char *key, bool value) {
        {
            std::lock_guard lock(mutex);
            state["settings"][key] = value;
            dirty = true;
        }
        wake.notify_all();
        update();
    }
    void refresh() {
        {
            std::lock_guard lock(mutex);
            refresh_requested = true;
        }
        wake.notify_all();
    }
    void login(bool enabled) {
        if (test)
            return;
        HKEY key{};
        if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0,
                            nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS)
            throw std::runtime_error("Unable to update Start with Windows");
        LSTATUS status;
        if (enabled) {
            wchar_t executable[32768];
            GetModuleFileNameW(nullptr, executable, 32768);
            const std::wstring command = L"\"" + std::wstring(executable) + L"\"";
            status = RegSetValueExW(key, L"com.local.codextokenoverlay", 0, REG_SZ,
                                    reinterpret_cast<const BYTE *>(command.c_str()),
                                    static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t)));
        } else
            status = RegDeleteValueW(key, L"com.local.codextokenoverlay");
        RegCloseKey(key);
        if (status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND)
            throw std::runtime_error("Unable to update Start with Windows");
    }
    void save_position() {
        {
            std::lock_guard lock(mutex);
            state["window"] = capture_position(hwnd);
            dirty = true;
        }
        wake.notify_all();
    }
    int expanded_height() const {
        return 460 + 20 * std::min(2, int(view["additionalLimits"].size()));
    }
    void size_window() {
        const int width = static_cast<int>((expanded ? 380 : 340) * scale),
                  height = static_cast<int>((expanded ? expanded_height() : 88) * scale);
        RECT current{};
        GetWindowRect(hwnd, &current);
        MONITORINFO monitor{sizeof(monitor)};
        GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &monitor);
        int x = std::clamp<int>(current.left, monitor.rcWork.left,
                                std::max<int>(monitor.rcWork.left, monitor.rcWork.right - width));
        int y = std::clamp<int>(current.top, monitor.rcWork.top,
                                std::max<int>(monitor.rcWork.top, monitor.rcWork.bottom - height));
        SetWindowPos(hwnd, view["settings"]["alwaysOnTop"].get<bool>() ? HWND_TOPMOST : HWND_NOTOPMOST, x, y,
                     width, height, SWP_NOACTIVATE);
        layout_buttons();
    }
    void toggle_expanded(bool value) {
        expanded = value;
        set_setting("expanded", value);
        size_window();
        hide_tooltip();
        build_graph();
        InvalidateRect(hwnd, nullptr, FALSE);
    }
    void show() {
        ShowWindow(hwnd, SW_SHOWNORMAL);
        update();
        SetForegroundWindow(hwnd);
    }
    void hide() {
        KillTimer(hwnd, 1);
        ShowWindow(hwnd, SW_HIDE);
        hide_tooltip();
        lines.clear();
        marks.clear();
        brush.Reset();
        target.Reset();
        fonts.clear();
    }
    void layout_buttons() {
        for (auto button : buttons) {
            const int id = GetDlgCtrlID(button);
            const bool visible = expanded ? id != expand_id : id == expand_id;
            ShowWindow(button, visible ? SW_SHOW : SW_HIDE);
            if (!visible)
                continue;
            float x = expanded ? (id == refresh_id ? 265.f : id == collapse_id ? 300.f : 340.f) : 300.f;
            SetWindowPos(button, nullptr, int(x * scale), int(28 * scale), int(28 * scale), int(28 * scale),
                         SWP_NOZORDER | SWP_NOACTIVATE);
        }
    }
    void update() {
        Json copy;
        {
            std::lock_guard lock(mutex);
            copy = snapshot(state, connection, error, now());
        }
        const bool graph_changed = view.is_null() || view["reset"] != copy["reset"];
        const int old_height = expanded_height();
        view = std::move(copy);
        if (expanded && old_height != expanded_height())
            size_window();
        const auto tip = wide("Codex usage: " + percent(view["reset"]["usedPercent"]) +
                              (view["stale"].get<bool>() ? " (last synced)" : ""));
        wcsncpy_s(tray.szTip, tip.c_str(), _TRUNCATE);
        if (tray.hWnd)
            Shell_NotifyIconW(NIM_MODIFY, &tray);
        if (IsWindowVisible(hwnd)) {
            if (graph_changed || lines.empty())
                build_graph();
            InvalidateRect(hwnd, nullptr, FALSE);
            schedule();
        }
    }
    void schedule() {
        KillTimer(hwnd, 1);
        if (!IsWindowVisible(hwnd))
            return;
        const auto at = now();
        Millis delay = 60000 - at % 60000;
        const auto reset = timestamp(view["reset"]["resetsAt"]);
        if (reset) {
            const auto remaining = *reset - at;
            if (remaining > 0)
                delay = std::min(delay, remaining % 60000 + 1);
        }
        const auto synced = timestamp(view["rateLimitsSyncedAt"]);
        if (synced && *synced + 120001 > at)
            delay = std::min(delay, *synced + 120001 - at);
        for (const auto &limit : view["additionalLimits"])
            if (number(limit["resetsAt"])) {
                auto until = static_cast<Millis>(limit["resetsAt"].get<double>() * 1000) - at;
                if (until > 0)
                    delay = std::min(delay, until);
            }
        SetTimer(hwnd, 1, static_cast<UINT>(std::clamp<Millis>(delay, 1, 60000)), nullptr);
    }
    void create_resources() {
        if (!factory && FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, factory.GetAddressOf())))
            throw std::runtime_error("Direct2D initialization failed");
        if (!text_factory &&
            FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                                       reinterpret_cast<IUnknown **>(text_factory.GetAddressOf()))))
            throw std::runtime_error("DirectWrite initialization failed");
        if (!target) {
            RECT rect{};
            GetClientRect(hwnd, &rect);
            auto properties = D2D1::RenderTargetProperties();
            properties.dpiX = properties.dpiY = 96 * scale;
            if (FAILED(factory->CreateHwndRenderTarget(
                    properties, D2D1::HwndRenderTargetProperties(hwnd, D2D1::SizeU(rect.right, rect.bottom)),
                    target.GetAddressOf())))
                throw std::runtime_error("Unable to create drawing surface");
            target->CreateSolidColorBrush(D2D1::ColorF(0xffffff), brush.GetAddressOf());
            build_graph();
        }
    }
    void text(const std::string &value, float x, float y, float width, float height, int size,
              unsigned color = 0xe9edf7, bool bold = false, bool centered = false) {
        const int key = size * 2 + int(bold);
        if (!fonts.contains(key)) {
            ComPtr<IDWriteTextFormat> format;
            text_factory->CreateTextFormat(L"Segoe UI", nullptr,
                                           bold ? DWRITE_FONT_WEIGHT_SEMI_BOLD : DWRITE_FONT_WEIGHT_NORMAL,
                                           DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, float(size),
                                           L"en-US", format.GetAddressOf());
            format->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
            fonts.emplace(key, std::move(format));
        }
        brush->SetColor(D2D1::ColorF(color));
        fonts[key]->SetTextAlignment(centered ? DWRITE_TEXT_ALIGNMENT_CENTER : DWRITE_TEXT_ALIGNMENT_LEADING);
        fonts[key]->SetParagraphAlignment(centered ? DWRITE_PARAGRAPH_ALIGNMENT_CENTER
                                                   : DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
        const auto label = wide(value);
        target->DrawText(label.c_str(), static_cast<UINT32>(label.size()), fonts[key].Get(),
                         D2D1::RectF(x, y, x + width, y + height), brush.Get(), D2D1_DRAW_TEXT_OPTIONS_CLIP);
    }
    void line(float x1, float y1, float x2, float y2, unsigned color, float thickness = 1) {
        brush->SetColor(D2D1::ColorF(color));
        target->DrawLine(D2D1::Point2F(x1, y1), D2D1::Point2F(x2, y2), brush.Get(), thickness);
    }
    void rounded(float x, float y, float width, float height, unsigned color, float radius = 12) {
        brush->SetColor(D2D1::ColorF(color));
        target->FillRoundedRectangle(
            D2D1::RoundedRect(D2D1::RectF(x, y, x + width, y + height), radius, radius), brush.Get());
    }
    float px(const Json &point) const {
        return 49.f +
               float((*timestamp(point["at"]) - chart_start) / double(chart_reset - chart_start)) * 296.f;
    }
    float py(double used) const {
        return 383.f - float(used / chart_ceiling) * 103.f;
    }
    void build_graph() {
        lines.clear();
        marks.clear();
        if (!expanded || !factory || view.is_null())
            return;
        const auto &reset = view["reset"];
        const auto start = timestamp(reset["startsAt"]), end = timestamp(reset["resetsAt"]);
        if (!start || !end || *end <= *start)
            return;
        chart_start = *start;
        chart_reset = *end;
        chart_ceiling = 100;
        Json points = Json::array();
        for (const auto &p : reset["observations"]) {
            const auto at = timestamp(p["at"]);
            if (at && *at >= *start && *at < *end) {
                points.push_back(p);
                chart_ceiling = std::max(chart_ceiling, p["usedPercent"].get<double>());
                if (p.contains("projectedUsedPercent") && number(p["projectedUsedPercent"]))
                    chart_ceiling = std::max(chart_ceiling, p["projectedUsedPercent"].get<double>());
            }
        }
        const auto projected = reset["projection"]["projectedUsedPercent"];
        if (number(projected))
            chart_ceiling = std::max(chart_ceiling, projected.get<double>());
        chart_ceiling = std::ceil(chart_ceiling / 25) * 25;
        for (bool forecast : {false, true})
            for (const auto &group : segments(points, forecast)) {
                ComPtr<ID2D1PathGeometry> geometry;
                factory->CreatePathGeometry(geometry.GetAddressOf());
                ComPtr<ID2D1GeometrySink> sink;
                geometry->Open(sink.GetAddressOf());
                bool first = true;
                for (const auto &p : group) {
                    const auto used = p[forecast ? "projectedUsedPercent" : "usedPercent"].get<double>();
                    const auto position = D2D1::Point2F(px(p), py(used));
                    if (first) {
                        sink->BeginFigure(position, D2D1_FIGURE_BEGIN_HOLLOW);
                        first = false;
                    } else
                        sink->AddLine(position);
                    marks.push_back({position.x, position.y, p, forecast});
                }
                sink->EndFigure(D2D1_FIGURE_END_OPEN);
                sink->Close();
                lines.push_back({geometry, D2D1::ColorF(forecast ? 0xb6a0ff : 0x72d4e8), forecast});
            }
        if (!points.empty() && number(projected) && points.back().contains("projectedUsedPercent") &&
            number(points.back()["projectedUsedPercent"])) {
            const auto &last = points.back();
            const double from = last.contains("projectedUsedPercent") && number(last["projectedUsedPercent"])
                                    ? last["projectedUsedPercent"].get<double>()
                                    : last["usedPercent"].get<double>();
            ComPtr<ID2D1PathGeometry> geometry;
            factory->CreatePathGeometry(geometry.GetAddressOf());
            ComPtr<ID2D1GeometrySink> sink;
            geometry->Open(sink.GetAddressOf());
            sink->BeginFigure(D2D1::Point2F(px(last), py(from)), D2D1_FIGURE_BEGIN_HOLLOW);
            sink->AddLine(D2D1::Point2F(345, py(projected.get<double>())));
            sink->EndFigure(D2D1_FIGURE_END_OPEN);
            sink->Close();
            lines.push_back({geometry, D2D1::ColorF(0xb6a0ff), true});
            marks.push_back({345,
                             py(projected.get<double>()),
                             {{"at", iso(*end)}, {"projectedUsedPercent", projected}, {"endpoint", true}},
                             true});
        }
    }
    void paint() {
        PAINTSTRUCT ps{};
        BeginPaint(hwnd, &ps);
        try {
            create_resources();
            target->BeginDraw();
            target->Clear(D2D1::ColorF(0x10131a));
            const auto &reset = view["reset"];
            const auto reset_time = timestamp(reset["resetsAt"]);
            const auto used = reset["usedPercent"];
            const auto projected = reset["projection"]["projectedUsedPercent"];
            const auto projection_text = number(projected)
                                             ? "Projected " + percent(projected, true) + " by reset"
                                             : "Projection unavailable";
            const auto count = reset_time ? countdown(*reset_time, now()) : "Reset unavailable";
            if (!expanded) {
                brush->SetColor(D2D1::ColorF(0x2b3140));
                target->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(45, 44), 27, 27), brush.Get(), 5);
                if (number(used)) {
                    const double fraction = std::clamp(used.get<double>() / 100, 0., 1.);
                    brush->SetColor(D2D1::ColorF(0x94a3ff));
                    for (int i = 0; i < int(fraction * 180); ++i) {
                        const double a = i * 6.283185307 / 180 - 1.5707963,
                                     b = (i + 1) * 6.283185307 / 180 - 1.5707963;
                        target->DrawLine(
                            D2D1::Point2F(45 + float(std::cos(a) * 27), 44 + float(std::sin(a) * 27)),
                            D2D1::Point2F(45 + float(std::cos(b) * 27), 44 + float(std::sin(b) * 27)),
                            brush.Get(), 5);
                    }
                }
                text(percent(used), 18, 17, 54, 54, 15, 0xe9edf7, true, true);
                text(view["stale"].get<bool>() ? "CODEX LIMIT  /  LAST SYNCED" : "CODEX LIMIT", 86, 13, 209,
                     18, 10, 0x9aa7bf);
                text(reset_time ? "Reset in " + count : count, 86, 31, 209, 25, 17, 0xe9edf7, true);
                text(projection_text, 86, 58, 212, 20, 11, 0xb6a0ff);
            } else {
                text("Codex usage", 19, 16, 240, 24, 17, 0xe9edf7, true);
                text(view["connection"].get<std::string>() == "online" ? "Account connected"
                                                                       : "Last synced / offline",
                     20, 39, 240, 17, 10, 0x9aa7bf);
                rounded(16, 65, 348, 167, 0x191f2b);
                text("CURRENT RESET WINDOW", 30, 78, 270, 18, 10, 0x9aa7bf);
                text(percent(used), 29, 97, 255, 57, 40, 0xe9edf7, true);
                text("USED", 307, 124, 50, 20, 10, 0x9aa7bf);
                rounded(30, 153, 320, 5, 0x2c3546, 2);
                if (number(used))
                    rounded(30, 153, float(std::clamp(used.get<double>(), 0., 100.) * 3.2), 5, 0x98a5ff, 2);
                text(reset_time ? hkt(*reset_time) : "Reset unavailable", 30, 170, 224, 20, 10, 0x9aa7bf);
                text(count, 249, 168, 107, 20, 11, 0xe9edf7, true);
                text(projection_text, 30, 201, 315, 22, 13, 0xb6a0ff, true);
                text("CURRENT RESET WINDOW TREND", 20, 247, 338, 18, 10, 0x9aa7bf);
                for (int i = 0; i < 3; ++i) {
                    const double value = chart_ceiling * i / 2;
                    const float y = py(value);
                    line(49, y, 345, y, 0x293140);
                    text(percent(value), 16, y - 7, 32, 18, 9, 0x9aa7bf);
                }
                if (!reset_time || marks.empty())
                    text("Waiting for observations", 65, 320, 260, 23, 12, 0x9aa7bf);
                for (const auto &path : lines) {
                    brush->SetColor(path.color);
                    target->DrawGeometry(path.geometry.Get(), brush.Get(), path.forecast ? 1.6f : 2.f);
                }
                for (const auto &mark : marks)
                    if (marks.size() < 100 || mark.point.contains("endpoint")) {
                        brush->SetColor(D2D1::ColorF(mark.forecast ? 0xb6a0ff : 0x72d4e8));
                        target->FillEllipse(D2D1::Ellipse(D2D1::Point2F(mark.x, mark.y), 2.3f, 2.3f),
                                            brush.Get());
                    }
                if (reset_time) {
                    text(hkt(chart_start).substr(5, 11), 49, 389, 140, 16, 9, 0x9aa7bf);
                    text(hkt(chart_reset).substr(5, 11), 260, 389, 95, 16, 9, 0x9aa7bf);
                }
                line(20, 417, 34, 417, 0x72d4e8, 2);
                text("Observed", 40, 409, 90, 20, 10, 0x9aa7bf);
                line(143, 417, 157, 417, 0xb6a0ff, 2);
                text("Projected at reset", 163, 409, 175, 20, 10, 0x9aa7bf);
                const auto &extras = view["additionalLimits"];
                extra_offset = std::clamp(extra_offset, 0, std::max(0, int(extras.size()) - 2));
                for (int row = 0; row < 2 && row + extra_offset < int(extras.size()); ++row) {
                    const auto &item = extras[row + extra_offset];
                    text(item["label"].get<std::string>(), 20, 436.f + row * 20, 260, 20, 10, 0x9aa7bf);
                    text(percent(item["usedPercent"]), 302, 436.f + row * 20, 60, 20, 11, 0xe9edf7, true);
                }
                std::string status = view["stale"].get<bool>() ? "Last synced - forecast unavailable"
                                     : extras.size() > 2       ? "Scroll here for other limits"
                                                               : "Updates every minute";
                if (view["connectionMessage"].is_string())
                    status = view["connectionMessage"].get<std::string>();
                text(status, 20, float(expanded_height() - 21), 340, 17, 9, 0x9aa7bf);
            }
            const auto result = target->EndDraw();
            if (result == D2DERR_RECREATE_TARGET) {
                brush.Reset();
                target.Reset();
                InvalidateRect(hwnd, nullptr, FALSE);
            }
        } catch (const std::exception &failure) {
            OutputDebugStringW(wide(failure.what()).c_str());
        }
        EndPaint(hwnd, &ps);
    }
    void hide_tooltip() {
        if (tooltip) {
            TOOLINFOW tool{sizeof(tool)};
            tool.hwnd = hwnd;
            tool.uId = 1;
            SendMessageW(tooltip, TTM_TRACKACTIVATE, FALSE, reinterpret_cast<LPARAM>(&tool));
        }
    }
    void hover(int x, int y) {
        if (!expanded || marks.empty() || y < 270 || y > 390) {
            hide_tooltip();
            return;
        }
        const Mark *closest = nullptr;
        float distance = 400;
        for (const auto &mark : marks) {
            const float dx = mark.x - x, dy = mark.y - y, d = dx * dx + dy * dy;
            if (d < distance) {
                distance = d;
                closest = &mark;
            }
        }
        if (!closest) {
            hide_tooltip();
            return;
        }
        const auto &point = closest->point;
        std::string message = hkt(*timestamp(point["at"]));
        if (point.contains("usedPercent"))
            message += "\nObserved " + percent(point["usedPercent"], true);
        message += "\nProjected at reset " + (point.contains("projectedUsedPercent")
                                                  ? (point["projectedUsedPercent"].is_null()
                                                         ? "Unavailable"
                                                         : percent(point["projectedUsedPercent"], true))
                                                  : "Not recorded");
        tooltip_text = wide(message);
        TOOLINFOW tool{sizeof(tool)};
        tool.hwnd = hwnd;
        tool.uId = 1;
        tool.lpszText = tooltip_text.data();
        SendMessageW(tooltip, TTM_UPDATETIPTEXTW, 0, reinterpret_cast<LPARAM>(&tool));
        POINT point_on_screen{int(x * scale), int((y + 18) * scale)};
        ClientToScreen(hwnd, &point_on_screen);
        SendMessageW(tooltip, TTM_TRACKPOSITION, 0, MAKELPARAM(point_on_screen.x, point_on_screen.y));
        SendMessageW(tooltip, TTM_TRACKACTIVATE, TRUE, reinterpret_cast<LPARAM>(&tool));
        TRACKMOUSEEVENT tracking{sizeof(tracking), TME_LEAVE, hwnd, 0};
        TrackMouseEvent(&tracking);
    }
    void menu() {
        HMENU menu = CreatePopupMenu();
        AppendMenuW(menu, MF_STRING, tray_visibility, IsWindowVisible(hwnd) ? L"Hide" : L"Show");
        AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
        AppendMenuW(menu, MF_STRING | (view["settings"]["alwaysOnTop"].get<bool>() ? MF_CHECKED : 0),
                    tray_pin, L"Always on top");
        AppendMenuW(menu, MF_STRING | (view["settings"]["startAtLogin"].get<bool>() ? MF_CHECKED : 0),
                    tray_login, L"Start with Windows");
        AppendMenuW(menu, MF_STRING, tray_refresh, L"Refresh now");
        AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
        AppendMenuW(menu, MF_STRING, tray_quit, L"Quit");
        POINT position{};
        GetCursorPos(&position);
        SetForegroundWindow(hwnd);
        const auto id =
            TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, position.x, position.y, 0, hwnd, nullptr);
        DestroyMenu(menu);
        if (id)
            command(id);
        PostMessageW(hwnd, WM_NULL, 0, 0);
    }
    void command(UINT id) {
        try {
            switch (id) {
            case expand_id:
                toggle_expanded(true);
                break;
            case collapse_id:
                toggle_expanded(false);
                break;
            case refresh_id:
            case tray_refresh:
                refresh();
                break;
            case hide_id:
                hide();
                break;
            case tray_visibility:
                if (IsWindowVisible(hwnd))
                    hide();
                else
                    show();
                break;
            case tray_pin: {
                const bool value = !view["settings"]["alwaysOnTop"].get<bool>();
                set_setting("alwaysOnTop", value);
                size_window();
                break;
            }
            case tray_login: {
                const bool value = !view["settings"]["startAtLogin"].get<bool>();
                login(value);
                set_setting("startAtLogin", value);
                break;
            }
            case tray_quit:
                quitting = true;
                save_position();
                DestroyWindow(hwnd);
                break;
            }
        } catch (const std::exception &failure) {
            MessageBoxW(hwnd, wide(failure.what()).c_str(), L"Codex Token Overlay", MB_ICONERROR);
        }
    }
};
HICON make_icon() {
    BITMAPV5HEADER header{};
    header.bV5Size = sizeof(header);
    header.bV5Width = 32;
    header.bV5Height = -32;
    header.bV5Planes = 1;
    header.bV5BitCount = 32;
    header.bV5Compression = BI_BITFIELDS;
    header.bV5RedMask = 0x00ff0000;
    header.bV5GreenMask = 0x0000ff00;
    header.bV5BlueMask = 0x000000ff;
    header.bV5AlphaMask = 0xff000000;
    void *memory{};
    HDC dc = GetDC(nullptr);
    HBITMAP color =
        CreateDIBSection(dc, reinterpret_cast<BITMAPINFO *>(&header), DIB_RGB_COLORS, &memory, nullptr, 0);
    ReleaseDC(nullptr, dc);
    auto pixels = static_cast<DWORD *>(memory);
    for (int y = 0; y < 32; ++y)
        for (int x = 0; x < 32; ++x) {
            const double r = std::hypot(x - 15.5, y - 15.5);
            pixels[y * 32 + x] = (r < 5 || (r > 10 && r < 14)) ? 0xff98a5ff : 0;
        }
    HBITMAP mask = CreateBitmap(32, 32, 1, 1, nullptr);
    ICONINFO info{TRUE, 0, 0, mask, color};
    HICON icon = CreateIconIndirect(&info);
    DeleteObject(mask);
    DeleteObject(color);
    return icon;
}
LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM w, LPARAM l) {
    auto app = reinterpret_cast<App *>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        app = static_cast<App *>(reinterpret_cast<CREATESTRUCTW *>(l)->lpCreateParams);
        app->hwnd = window;
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(app));
    }
    if (!app)
        return DefWindowProcW(window, message, w, l);
    try {
        switch (message) {
        case WM_CREATE: {
            app->scale = GetDpiForWindow(window) / 96.f;
            for (const auto &item :
                 std::vector<std::pair<UINT, const wchar_t *>>{{expand_id, L"Expand overlay"},
                                                               {collapse_id, L"Collapse"},
                                                               {refresh_id, L"Refresh"},
                                                               {hide_id, L"Hide"}}) {
                auto button =
                    CreateWindowExW(0, L"BUTTON", item.second, WS_CHILD | WS_TABSTOP | BS_OWNERDRAW, 0, 0, 20,
                                    20, window, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(item.first)),
                                    GetModuleHandleW(nullptr), nullptr);
                SetWindowSubclass(button, overlay_button_subclass, 1, 0);
                app->buttons.push_back(button);
            }
            app->tooltip = CreateWindowExW(WS_EX_TOPMOST, TOOLTIPS_CLASSW, nullptr,
                                           WS_POPUP | TTS_ALWAYSTIP | TTS_NOPREFIX, 0, 0, 0, 0, window,
                                           nullptr, GetModuleHandleW(nullptr), nullptr);
            TOOLINFOW tool{sizeof(tool)};
            tool.uFlags = TTF_TRACK | TTF_ABSOLUTE;
            tool.hwnd = window;
            tool.uId = 1;
            tool.lpszText = const_cast<wchar_t *>(L"Quota trend");
            if (!app->tooltip ||
                !SendMessageW(app->tooltip, TTM_ADDTOOLW, 0, reinterpret_cast<LPARAM>(&tool)))
                throw std::runtime_error("Unable to initialize quota tooltip");
            SendMessageW(app->tooltip, TTM_SETMAXTIPWIDTH, 0, 340);
            app->icon = make_icon();
            app->tray.cbSize = sizeof(app->tray);
            app->tray.hWnd = window;
            app->tray.uID = 1;
            app->tray.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            app->tray.uCallbackMessage = tray_message;
            app->tray.hIcon = app->icon;
            wcscpy_s(app->tray.szTip, L"Codex usage");
            Shell_NotifyIconW(NIM_ADD, &app->tray);
            app->size_window();
            return 0;
        }
        case WM_PAINT:
            app->paint();
            return 0;
        case WM_ERASEBKGND:
            return 1;
        case WM_COMMAND:
            app->command(LOWORD(w));
            return 0;
        case WM_DRAWITEM: {
            auto draw = reinterpret_cast<DRAWITEMSTRUCT *>(l);
            auto dc = draw->hDC;
            HBRUSH background =
                CreateSolidBrush((draw->itemState & ODS_SELECTED) ? RGB(49, 58, 79) : RGB(25, 31, 43));
            FillRect(dc, &draw->rcItem, background);
            DeleteObject(background);
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, RGB(222, 230, 250));
            HFONT font = CreateFontW(int(-19 * app->scale), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                     DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                                     CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI Symbol");
            auto old = SelectObject(dc, font);
            const wchar_t *glyph = draw->CtlID == expand_id     ? L"⌄"
                                   : draw->CtlID == collapse_id ? L"⌃"
                                   : draw->CtlID == refresh_id  ? L"↻"
                                                                : L"×";
            DrawTextW(dc, glyph, -1, &draw->rcItem, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
            SelectObject(dc, old);
            DeleteObject(font);
            if (draw->itemState & ODS_FOCUS)
                DrawFocusRect(dc, &draw->rcItem);
            return TRUE;
        }
        case WM_NCHITTEST: {
            const auto hit = DefWindowProcW(window, message, w, l);
            if (hit == HTCLIENT) {
                POINT p{GET_X_LPARAM(l), GET_Y_LPARAM(l)};
                ScreenToClient(window, &p);
                if (p.y < int((app->expanded ? 60 : 88) * app->scale))
                    return HTCAPTION;
            }
            return hit;
        }
        case WM_SIZE:
            if (app->target) {
                app->target->Resize(D2D1::SizeU(LOWORD(l), HIWORD(l)));
            }
            return 0;
        case WM_EXITSIZEMOVE:
            app->save_position();
            return 0;
        case WM_DPICHANGED: {
            app->scale = HIWORD(w) / 96.f;
            const auto bounds = reinterpret_cast<RECT *>(l);
            SetWindowPos(window, nullptr, bounds->left, bounds->top, bounds->right - bounds->left,
                         bounds->bottom - bounds->top, SWP_NOZORDER | SWP_NOACTIVATE);
            app->brush.Reset();
            app->target.Reset();
            app->fonts.clear();
            app->size_window();
            app->save_position();
            InvalidateRect(window, nullptr, FALSE);
            return 0;
        }
        case WM_DISPLAYCHANGE:
            app->size_window();
            return 0;
        case WM_MOUSEMOVE:
            app->hover(int(GET_X_LPARAM(l) / app->scale), int(GET_Y_LPARAM(l) / app->scale));
            return 0;
        case WM_MOUSELEAVE:
            app->hide_tooltip();
            return 0;
        case WM_MOUSEWHEEL:
            app->extra_offset += GET_WHEEL_DELTA_WPARAM(w) < 0 ? 1 : -1;
            InvalidateRect(window, nullptr, FALSE);
            return 0;
        case WM_TIMER:
            app->update();
            return 0;
        case WM_POWERBROADCAST:
            if (w == PBT_APMRESUMEAUTOMATIC || w == PBT_APMRESUMESUSPEND) {
                app->refresh();
                app->update();
            }
            return TRUE;
        case WM_TIMECHANGE:
            app->update();
            app->refresh();
            return 0;
        case WM_CLOSE:
            app->hide();
            return 0;
        case WM_QUERYENDSESSION:
            return TRUE;
        case WM_ENDSESSION:
            if (w) {
                app->stopped = true;
                app->wake.notify_all();
                if (app->worker.joinable())
                    app->worker.join();
            }
            return 0;
        case WM_DESTROY:
            app->stopped = true;
            app->wake.notify_all();
            PostQuitMessage(0);
            return 0;
        case model_message:
            app->update();
            return 0;
        case show_message:
            app->show();
            return 0;
        case tray_message:
            if (l == WM_LBUTTONUP)
                app->command(tray_visibility);
            else if (l == WM_RBUTTONUP || l == WM_CONTEXTMENU)
                app->menu();
            return 0;
        }
        static const UINT taskbar = RegisterWindowMessageW(L"TaskbarCreated");
        if (message == taskbar) {
            Shell_NotifyIconW(NIM_ADD, &app->tray);
            return 0;
        }
    } catch (const std::exception &failure) {
        OutputDebugStringW(wide(failure.what()).c_str());
    }
    return DefWindowProcW(window, message, w, l);
}
} // namespace
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    bool isolated =
        environment(L"CODEX_OVERLAY_E2E") == L"1" && !environment(L"CODEX_OVERLAY_E2E_USER_DATA").empty();
    try {
        const fs::path profile = isolated ? fs::path(environment(L"CODEX_OVERLAY_E2E_USER_DATA"))
                                          : fs::path(environment(L"APPDATA")) / L"codex-token-overlay";
        fs::create_directories(profile);
        const auto id = wide(sha256(utf8(fs::weakly_canonical(profile).wstring())).substr(0, 16));
        Handle mutex(CreateMutexW(nullptr, TRUE, (L"Local\\CodexTokenOverlayNative-" + id).c_str()));
        if (!mutex)
            throw std::runtime_error("Unable to acquire single-instance lock");
        if (GetLastError() == ERROR_ALREADY_EXISTS) {
            auto existing = FindWindowW(window_class, (L"Codex Token Overlay | " + id).c_str());
            if (existing)
                PostMessageW(existing, show_message, 0, 0);
            return 0;
        }
        // Same exclusive writer lock held by Electron's Windows ProcessSingleton.
        // The sharing check is atomic and protects both launch orders, including v0.1.15.
        Handle profile_lock(CreateFileW((profile / L"lockfile").c_str(), GENERIC_WRITE, FILE_SHARE_READ,
                                        nullptr, CREATE_ALWAYS,
                                        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE, nullptr));
        if (!profile_lock)
            throw std::runtime_error("This overlay profile is in use. Close the existing overlay before "
                                     "opening the native version. Your data has not been changed.");
        CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_STANDARD_CLASSES | ICC_WIN95_CLASSES};
        InitCommonControlsEx(&controls);
        App app(fs::weakly_canonical(profile), isolated);
        WNDCLASSEXW klass{sizeof(klass)};
        klass.lpfnWndProc = window_proc;
        klass.hInstance = instance;
        klass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        klass.lpszClassName = window_class;
        RegisterClassExW(&klass);
        POINT location{CW_USEDEFAULT, CW_USEDEFAULT};
        if (number(app.state["window"]["x"]) && number(app.state["window"]["y"])) {
            location =
                restore_position(app.state["window"], {app.expanded ? 380L : 340L,
                                                       app.expanded ? LONG(app.expanded_height()) : 88L});
        } else {
            RECT work{};
            SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
            location = {work.right - (app.expanded ? 400 : 360), work.top + 20};
        }
        HWND window =
            CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_CONTROLPARENT, window_class, app.title.c_str(),
                            WS_POPUP | WS_CLIPCHILDREN, location.x, location.y, app.expanded ? 380 : 340,
                            app.expanded ? app.expanded_height() : 88, nullptr, nullptr, instance, &app);
        if (!window)
            throw std::runtime_error("Unable to create overlay window");
        app.login(app.state["settings"]["startAtLogin"]);
        ShowWindow(window, SW_SHOWNOACTIVATE);
        app.update();
        app.run_service();
        MSG message{};
        while (GetMessageW(&message, nullptr, 0, 0) > 0) {
            if (!IsDialogMessageW(window, &message)) {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        return 0;
    } catch (const std::exception &failure) {
        if (isolated) {
            OutputDebugStringW(wide(failure.what()).c_str());
            return 1;
        }
        MessageBoxW(nullptr, wide(failure.what()).c_str(), L"Codex Token Overlay", MB_OK | MB_ICONERROR);
        return 1;
    }
}
