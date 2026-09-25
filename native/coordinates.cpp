#include "platform.hpp"
#include <algorithm>
#include <cmath>
#include <shellscalingapi.h>

namespace overlay {
namespace {
LONG rounded(double value) {
    return static_cast<LONG>(std::round(value));
}
LONG floored(double value) {
    return static_cast<LONG>(std::floor(value));
}
bool touches(const RECT &a, const RECT &b) {
    return (std::max(a.left, b.left) == std::min(a.right, b.right) && a.top <= b.bottom &&
            b.top <= a.bottom) ||
           (std::max(a.top, b.top) == std::min(a.bottom, b.bottom) && a.left <= b.right && b.left <= a.right);
}
// Align a shared edge in DIP space. Preserve end alignment when only the ends match.
LONG aligned_offset(LONG begin, LONG end, LONG other_begin, LONG other_end, double scale, double other_scale,
                    LONG length, LONG other_length) {
    if (end == other_end && begin != other_begin)
        return length - other_length;
    if (other_begin >= begin && other_begin <= end)
        return floored((other_begin - begin) / scale);
    if (other_end >= begin && other_end <= end)
        return length - other_length - floored((end - other_end) / scale);
    return floored((other_begin - begin) / other_scale);
}
std::vector<MonitorSpace> system_monitors() {
    std::vector<MonitorSpace> monitors;
    EnumDisplayMonitors(
        nullptr, nullptr,
        [](HMONITOR monitor, HDC, LPRECT rect, LPARAM data) -> BOOL {
            UINT x = 96, y = 96;
            GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &x, &y);
            MONITORINFOEXW info{};
            info.cbSize = sizeof(info);
            GetMonitorInfoW(monitor, &info);
            reinterpret_cast<std::vector<MonitorSpace> *>(data)->push_back(
                {*rect, x / 96.0, {}, info.szDevice});
            return TRUE;
        },
        reinterpret_cast<LPARAM>(&monitors));
    layout_monitors(monitors);
    return monitors;
}
const MonitorSpace &matching_monitor(RECT window, const std::vector<MonitorSpace> &monitors, bool dips) {
    const MonitorSpace *best = &monitors.front();
    double distance = 1e30;
    for (const auto &monitor : monitors) {
        const auto &r = dips ? monitor.dips : monitor.pixels;
        const double overlap_x =
            std::max(0L, std::min(window.right, r.right) - std::max(window.left, r.left));
        const double overlap_y =
            std::max(0L, std::min(window.bottom, r.bottom) - std::max(window.top, r.top));
        const double dx = std::max({0L, r.left - window.right, window.left - r.right});
        const double dy = std::max({0L, r.top - window.bottom, window.top - r.bottom});
        const double score = overlap_x && overlap_y ? -overlap_x * overlap_y : dx * dx + dy * dy;
        if (score < distance) {
            best = &monitor;
            distance = score;
        }
    }
    return *best;
}
} // namespace
void layout_monitors(std::vector<MonitorSpace> &monitors) {
    if (monitors.empty())
        return;
    size_t primary = 0;
    for (size_t i = 0; i < monitors.size(); ++i) {
        auto &m = monitors[i];
        if (m.pixels.left == 0 && m.pixels.top == 0)
            primary = i;
        const LONG x = floored(m.pixels.left / m.scale), y = floored(m.pixels.top / m.scale);
        m.dips = {x, y, x + floored((m.pixels.right - m.pixels.left) / m.scale),
                  y + floored((m.pixels.bottom - m.pixels.top) / m.scale)};
    }
    std::vector<bool> placed(monitors.size());
    placed[primary] = true;
    std::vector<size_t> parents{primary};
    while (!parents.empty()) {
        const auto parent = monitors[parents.back()];
        parents.pop_back();
        for (size_t i = 0; i < monitors.size(); ++i) {
            auto &child = monitors[i];
            const auto &a = parent.pixels, &b = child.pixels, &d = parent.dips;
            if (placed[i] || !touches(a, b))
                continue;
            const LONG width = child.dips.right - child.dips.left,
                       height = child.dips.bottom - child.dips.top;
            LONG x{}, y{};
            const bool corner = std::max(a.left, b.left) == std::min(a.right, b.right) &&
                                std::max(a.top, b.top) == std::min(a.bottom, b.bottom);
            const bool vertical = corner ? a.bottom == b.top || (a.left != b.right && a.top == b.bottom)
                                         : a.top == b.bottom || a.bottom == b.top;
            if (vertical) {
                x = d.left + aligned_offset(a.left, a.right, b.left, b.right, parent.scale, child.scale,
                                            d.right - d.left, width);
                y = a.bottom == b.top ? d.bottom : d.top - height;
            } else {
                x = a.right == b.left ? d.right : d.left - width;
                y = d.top + aligned_offset(a.top, a.bottom, b.top, b.bottom, parent.scale, child.scale,
                                           d.bottom - d.top, height);
            }
            child.dips = {x, y, x + width, y + height};
            placed[i] = true;
            parents.push_back(i);
        }
    }
}
POINT convert_point(POINT point, const MonitorSpace &monitor, bool to_pixels) {
    const auto &from = to_pixels ? monitor.dips : monitor.pixels;
    const auto &to = to_pixels ? monitor.pixels : monitor.dips;
    const double factor = to_pixels ? monitor.scale : 1.0 / monitor.scale;
    return {to.left + rounded((point.x - from.left) * factor),
            to.top + rounded((point.y - from.top) * factor)};
}
Json encode_position(RECT window, const std::vector<MonitorSpace> &monitors) {
    if (monitors.empty())
        return {{"x", window.left}, {"y", window.top}};
    const auto &monitor = matching_monitor(window, monitors, false);
    const auto dip = convert_point({window.left, window.top}, monitor, false);
    // DIP monitor rectangles can overlap. Keep an optional native anchor to
    // disambiguate them; v0.1.15 still reads the standard x/y and ignores this key.
    return {{"x", dip.x},
            {"y", dip.y},
            {"nativeAnchor",
             {{"device", utf8(monitor.device)},
              {"dipX", dip.x},
              {"dipY", dip.y},
              {"offsetX", (window.left - monitor.pixels.left) / monitor.scale},
              {"offsetY", (window.top - monitor.pixels.top) / monitor.scale}}}};
}
POINT decode_position(const Json &window, SIZE size, const std::vector<MonitorSpace> &monitors) {
    const POINT dip{window.at("x").get<LONG>(), window.at("y").get<LONG>()};
    if (monitors.empty())
        return dip;
    const auto anchor = window.value("nativeAnchor", Json());
    if (anchor.is_object() && anchor.value("dipX", Json()) == window["x"] &&
        anchor.value("dipY", Json()) == window["y"] && number(anchor.value("offsetX", Json())) &&
        number(anchor.value("offsetY", Json())) && anchor.value("device", Json()).is_string()) {
        for (const auto &monitor : monitors)
            if (!monitor.device.empty() && utf8(monitor.device) == anchor["device"].get<std::string>())
                return {monitor.pixels.left + rounded(anchor["offsetX"].get<double>() * monitor.scale),
                        monitor.pixels.top + rounded(anchor["offsetY"].get<double>() * monitor.scale)};
    }
    const RECT rect{dip.x, dip.y, dip.x + size.cx, dip.y + size.cy};
    return convert_point(dip, matching_monitor(rect, monitors, true), true);
}
Json capture_position(HWND window) {
    RECT rect{};
    GetWindowRect(window, &rect);
    return encode_position(rect, system_monitors());
}
POINT restore_position(const Json &window, SIZE size) {
    return decode_position(window, size, system_monitors());
}
} // namespace overlay
