#include "core.hpp"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace overlay {
Millis now() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}
bool number(const Json &v) {
    return v.is_number() && std::isfinite(v.get<double>());
}
std::optional<Millis> timestamp(const Json &v) {
    if (!v.is_string())
        return {};
    const auto s = v.get<std::string>();
    int y{}, m{}, d{}, h{}, min{}, sec{}, consumed{};
    if (sscanf_s(s.c_str(), "%d-%d-%dT%d:%d:%d%n", &y, &m, &d, &h, &min, &sec, &consumed) != 6)
        return {};
    const std::chrono::year_month_day date{std::chrono::year{y}, std::chrono::month{unsigned(m)},
                                           std::chrono::day{unsigned(d)}};
    if (!date.ok() || h < 0 || h > 23 || min < 0 || min > 59 || sec < 0 || sec > 59)
        return {};
    size_t pos = static_cast<size_t>(consumed);
    int ms = 0;
    if (pos < s.size() && s[pos] == '.') {
        ++pos;
        int factor = 100;
        size_t start = pos;
        while (pos < s.size() && s[pos] >= '0' && s[pos] <= '9') {
            ms += (s[pos++] - '0') * factor;
            factor /= 10;
        }
        if (pos == start)
            return {};
    }
    int offset = 0;
    if (pos < s.size() && s[pos] == 'Z')
        ++pos;
    else if (pos < s.size() && (s[pos] == '+' || s[pos] == '-')) {
        const int sign = s[pos++] == '+' ? 1 : -1;
        int oh{}, om{}, n{};
        if (sscanf_s(s.c_str() + pos, "%d:%d%n", &oh, &om, &n) != 2 || oh > 23 || om > 59 || oh < 0 || om < 0)
            return {};
        offset = sign * (oh * 60 + om);
        pos += n;
    } else
        return {};
    if (pos != s.size())
        return {};
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::sys_days{date}.time_since_epoch())
               .count() +
           ((h * 60LL + min - offset) * 60 + sec) * 1000 + ms;
}
std::string iso(Millis ms) {
    using namespace std::chrono;
    const sys_time<milliseconds> t{milliseconds{ms}};
    const auto day = floor<days>(t);
    const year_month_day date{day};
    const hh_mm_ss time{t - day};
    char out[40];
    sprintf_s(out, "%04d-%02u-%02uT%02d:%02d:%02d.%03dZ", int(date.year()), unsigned(date.month()),
              unsigned(date.day()), int(time.hours().count()), int(time.minutes().count()),
              int(time.seconds().count()), int(time.subseconds().count()));
    return out;
}
static Json field(const Json &v, const char *key) {
    return v.is_object() ? v.value(key, Json()) : Json();
}
static Json window(const Json &v) {
    if (!v.is_object() || !number(field(v, "usedPercent")) || !number(field(v, "windowDurationMins")) ||
        !number(field(v, "resetsAt")))
        return nullptr;
    return {{"usedPercent", v["usedPercent"]},
            {"windowDurationMins", v["windowDurationMins"]},
            {"resetsAt", v["resetsAt"]}};
}
static Json bucket(const Json &v) {
    if (!v.is_object() || !field(v, "limitId").is_string())
        return nullptr;
    Json result{{"limitId", v["limitId"]},
                {"primary", window(field(v, "primary"))},
                {"secondary", window(field(v, "secondary"))}};
    for (const auto key : {"limitName", "planType", "rateLimitReachedType"})
        result[key] = field(v, key).is_string() ? v[key] : Json();
    return result;
}
Json parse_limits(const Json &response) {
    Json result = Json::array();
    auto map = field(response, "rateLimitsByLimitId");
    if (map.is_object())
        for (const auto &raw : map) {
            auto b = bucket(raw);
            if (!b.is_null())
                result.push_back(b);
        }
    if (result.empty()) {
        auto b = bucket(field(response, "rateLimits"));
        if (!b.is_null())
            result.push_back(b);
    }
    std::stable_sort(result.begin(), result.end(), [](const Json &a, const Json &b) {
        const auto x = a["limitId"].get<std::string>(), y = b["limitId"].get<std::string>();
        return x == y ? false : x == "codex" ? true : y == "codex" ? false : x < y;
    });
    return result;
}
Json defaults() {
    return {{"version", 1},
            {"settings", {{"alwaysOnTop", true}, {"startAtLogin", true}, {"expanded", false}}},
            {"window", {{"x", nullptr}, {"y", nullptr}}},
            {"rateLimits", Json::array()},
            {"rateLimitsSyncedAt", nullptr},
            {"quotaHistory", nullptr}};
}
Json projection(const Json &used, const Json &start, const Json &reset, Millis at) {
    const Json unavailable{{"status", "unavailable"}, {"projectedUsedPercent", nullptr}};
    if (!number(used) || !number(start) || !number(reset))
        return unavailable;
    const double s = start.get<double>(), r = reset.get<double>();
    if (r <= s || at < s || at >= r)
        return unavailable;
    const double u = std::max(0., used.get<double>());
    if (u == 0)
        return {{"status", "lasts-until-reset"}, {"projectedUsedPercent", 0}};
    if (at <= s)
        return unavailable;
    const double p = std::floor(u / ((at - s) / (r - s)) * 10 + 0.5) / 10;
    if (!std::isfinite(p))
        return unavailable;
    return {{"status", p > 100    ? "exhausts-before-reset"
                       : p == 100 ? "full-at-reset"
                                  : "lasts-until-reset"},
            {"projectedUsedPercent", p}};
}
bool same_cycle(const Json &history, const std::string &id, const Json &w) {
    return history.is_object() && history["limitId"] == id &&
           history["windowDurationMins"] == w["windowDurationMins"] &&
           std::abs(history["resetsAt"].get<double>() - w["resetsAt"].get<double>()) <= 60;
}
Json normalize_state(const Json &v) {
    const auto settings = field(v, "settings"), position = field(v, "window");
    if (field(v, "version") != 1 || !settings.is_object() || !position.is_object() ||
        !field(v, "rateLimits").is_array())
        throw std::runtime_error("Invalid quota state; original file was preserved.");
    for (const auto key : {"alwaysOnTop", "startAtLogin", "expanded"})
        if (!field(settings, key).is_boolean())
            throw std::runtime_error("Invalid overlay settings; original file was preserved.");
    for (const auto key : {"x", "y"})
        if (!position.contains(key) || (!position[key].is_null() && !number(position[key])))
            throw std::runtime_error("Invalid window position.");
    Json out = defaults();
    out["settings"] = settings;
    out["window"] = position;
    Json map = Json::object();
    size_t i = 0;
    for (const auto &b : v["rateLimits"])
        map[std::to_string(i++)] = b;
    out["rateLimits"] = parse_limits({{"rateLimitsByLimitId", map}});
    if (timestamp(field(v, "rateLimitsSyncedAt")))
        out["rateLimitsSyncedAt"] = v["rateLimitsSyncedAt"];
    const auto history = field(v, "quotaHistory");
    if (history.is_null())
        return out;
    if (!history.is_object() || !field(history, "limitId").is_string() || history["limitId"] == "" ||
        !number(field(history, "resetsAt")) || !number(field(history, "windowDurationMins")) ||
        history["windowDurationMins"].get<double>() <= 0 || !field(history, "observations").is_array())
        throw std::runtime_error("Invalid quota history; original file was preserved.");
    const double reset = history["resetsAt"].get<double>() * 1000,
                 start = reset - history["windowDurationMins"].get<double>() * 60000;
    Json points = Json::array();
    const auto &source = history["observations"];
    for (size_t n = source.size() > max_observations ? source.size() - max_observations : 0;
         n < source.size(); ++n) {
        const auto &p = source[n];
        const auto t = timestamp(field(p, "at"));
        if (!t || !number(field(p, "usedPercent")) || p["usedPercent"].get<double>() < 0 ||
            *t < start - 60000 || *t >= reset + 60000 ||
            (!points.empty() && *t <= *timestamp(points.back()["at"])))
            continue;
        Json point{{"at", iso(*t)}, {"usedPercent", p["usedPercent"]}};
        if (p.contains("projectedUsedPercent"))
            point["projectedUsedPercent"] =
                number(p["projectedUsedPercent"]) && p["projectedUsedPercent"].get<double>() >= 0
                    ? p["projectedUsedPercent"]
                    : Json();
        points.push_back(point);
    }
    out["quotaHistory"] = {{"limitId", history["limitId"]},
                           {"resetsAt", history["resetsAt"]},
                           {"windowDurationMins", history["windowDurationMins"]},
                           {"observations", points}};
    return out;
}
static Json primary(const Json &state) {
    for (const auto &b : state["rateLimits"])
        if (b["limitId"] == "codex")
            return b;
    return state["rateLimits"].empty() ? Json() : state["rateLimits"][0];
}
void observe(Json &state, Millis at) {
    const auto b = primary(state), w = field(b, "primary");
    if (w.is_null() || w["usedPercent"].get<double>() < 0 || w["windowDurationMins"].get<double>() <= 0)
        return;
    const double reset = w["resetsAt"].get<double>() * 1000,
                 start = reset - w["windowDurationMins"].get<double>() * 60000;
    if (at < start || at >= reset)
        return;
    if (!same_cycle(state["quotaHistory"], b["limitId"], w))
        state["quotaHistory"] = {{"limitId", b["limitId"]},
                                 {"resetsAt", w["resetsAt"]},
                                 {"windowDurationMins", w["windowDurationMins"]},
                                 {"observations", Json::array()}};
    auto &points = state["quotaHistory"]["observations"];
    if (!points.empty() && at < *timestamp(points.back()["at"]))
        return;
    Json point{
        {"at", iso(at)},
        {"usedPercent", w["usedPercent"]},
        {"projectedUsedPercent", projection(w["usedPercent"], start, reset, at)["projectedUsedPercent"]}};
    if (!points.empty() && at / 60000 == *timestamp(points.back()["at"]) / 60000)
        points.back() = point;
    else {
        points.push_back(point);
        if (points.size() > max_observations)
            points.erase(points.begin());
    }
}
static Json active(const Json &w, Millis at) {
    if (w.is_null())
        return nullptr;
    const double r = w["resetsAt"].get<double>() * 1000, d = w["windowDurationMins"].get<double>();
    return d <= 0 || r <= at || r - d * 60000 > at ? Json() : w;
}
Json snapshot(const Json &state, const std::string &connection, const std::string &error, Millis at) {
    const auto synced = timestamp(state["rateLimitsSyncedAt"]);
    const bool stale = connection != "online" || !synced || *synced > at || at - *synced > 120000;
    const auto b = primary(state), w = active(field(b, "primary"), at);
    Json reset = nullptr, start = nullptr, used = nullptr, points = Json::array();
    if (!w.is_null()) {
        reset = w["resetsAt"].get<double>() * 1000;
        start = reset.get<double>() - w["windowDurationMins"].get<double>() * 60000;
        used = w["usedPercent"];
        if (same_cycle(state["quotaHistory"], b["limitId"], w))
            points = state["quotaHistory"]["observations"];
    }
    Json extras = Json::array();
    for (const auto &other : state["rateLimits"])
        if (other["limitId"] != field(b, "limitId")) {
            const auto otherWindow = active(other["primary"], at);
            extras.push_back({{"limitId", other["limitId"]},
                              {"label", other["limitName"].is_null() ? other["limitId"] : other["limitName"]},
                              {"usedPercent", field(otherWindow, "usedPercent")},
                              {"resetsAt", field(otherWindow, "resetsAt")}});
        }
    const Millis projectedAt =
        points.empty() ? synced.value_or(at) : timestamp(points.back()["at"]).value_or(at);
    return {{"generatedAt", iso(at)},
            {"reset",
             {{"limitId", field(b, "limitId")},
              {"usedPercent", used},
              {"startsAt", start.is_null() ? Json() : Json(iso(static_cast<Millis>(start.get<double>())))},
              {"resetsAt", reset.is_null() ? Json() : Json(iso(static_cast<Millis>(reset.get<double>())))},
              {"projection", projection(stale ? Json() : used, start, reset, projectedAt)},
              {"observations", points}}},
            {"additionalLimits", extras},
            {"connection", connection},
            {"connectionMessage", error.empty() ? Json() : Json(error)},
            {"rateLimitsSyncedAt", state["rateLimitsSyncedAt"]},
            {"stale", stale},
            {"settings", state["settings"]}};
}
std::vector<std::vector<Json>> segments(const Json &points, bool forecasts) {
    std::vector<std::vector<Json>> result;
    std::vector<Json> group;
    for (const auto &p : points) {
        const bool valid =
            !forecasts || (p.contains("projectedUsedPercent") && number(p["projectedUsedPercent"]) &&
                           p["projectedUsedPercent"].get<double>() >= 0);
        if (!valid || (!group.empty() && *timestamp(p["at"]) - *timestamp(group.back()["at"]) > 120000)) {
            if (!group.empty())
                result.push_back(std::move(group));
            group.clear();
        }
        if (valid)
            group.push_back(p);
    }
    if (!group.empty())
        result.push_back(std::move(group));
    return result;
}
bool early_forecast(Millis start, Millis reset, Millis at) {
    constexpr Millis six_hours = 6 * 60 * 60 * 1000;
    return reset - start > six_hours && at >= start && at - start < six_hours;
}
Millis forecast_time(const Json &view) {
    const auto &points = view["reset"]["observations"];
    if (!points.empty())
        if (const auto at = timestamp(points.back()["at"]))
            return *at;
    return timestamp(view["rateLimitsSyncedAt"]).value_or(timestamp(view["generatedAt"]).value_or(0));
}
TrendDisplay trend_display(const Json &view) {
    TrendDisplay display;
    const auto &reset = view["reset"];
    const auto start = timestamp(reset["startsAt"]), end = timestamp(reset["resetsAt"]);
    if (!start || !end || *end <= *start)
        return display;
    for (const auto &point : reset["observations"]) {
        const auto at = timestamp(point["at"]);
        if (!at || *at < *start || *at >= *end)
            continue;
        display.points.push_back(point);
        display.ceiling = std::max(display.ceiling, point["usedPercent"].get<double>());
        auto forecast = point;
        if (early_forecast(*start, *end, *at))
            forecast["projectedUsedPercent"] = nullptr;
        if (forecast.contains("projectedUsedPercent") && number(forecast["projectedUsedPercent"]))
            display.ceiling = std::max(display.ceiling, forecast["projectedUsedPercent"].get<double>());
        display.forecasts.push_back(std::move(forecast));
    }
    if (!early_forecast(*start, *end, forecast_time(view))) {
        display.projected = reset["projection"]["projectedUsedPercent"];
        if (number(display.projected))
            display.ceiling = std::max(display.ceiling, display.projected.get<double>());
    }
    display.ceiling = std::ceil(display.ceiling / 25) * 25;
    return display;
}
std::string percent(const Json &v, bool decimal) {
    if (!number(v))
        return "N/A";
    const double rounded = std::round(v.get<double>() * (decimal ? 10 : 1)) / (decimal ? 10 : 1);
    std::ostringstream s;
    s << std::fixed << std::setprecision(decimal && std::floor(rounded) != rounded ? 1 : 0) << rounded;
    auto result = s.str();
    const auto dot = result.find('.');
    const auto end = dot == std::string::npos ? result.size() : dot;
    if (decimal)
        for (int at = int(end) - 3; at > (!result.empty() && result[0] == '-' ? 1 : 0); at -= 3)
            result.insert(at, ",");
    return result + '%';
}
std::string countdown(Millis reset, Millis at) {
    const auto minutes = std::max(0LL, (reset - at) / 60000), days = minutes / 1440,
               hours = minutes % 1440 / 60;
    return (days ? std::to_string(days) + "d " : "") + (days || hours ? std::to_string(hours) + "h " : "") +
           std::to_string(minutes % 60) + "m";
}
std::string hkt(Millis at) {
    auto s = iso(at + 8 * 3600000LL);
    return s.substr(0, 10) + " " + s.substr(11, 5) + " HKT";
}
} // namespace overlay
