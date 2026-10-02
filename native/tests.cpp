#include "platform.hpp"
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>

using namespace overlay;
static int assertions = 0;
static void require(bool condition, const char *message) {
    ++assertions;
    if (!condition)
        throw std::runtime_error(message);
}
int main(int argc, char **argv) {
    try {
        if (argc == 4 && std::string(argv[1]) == "--roundtrip") {
            Store input{fs::path(argv[2])};
            Store output{fs::path(argv[3])};
            auto state = input.load();
            output.load();
            output.save(state);
            return 0;
        }
        if (argc > 1 && std::string(argv[1]) == "app-server") {
            std::string line;
            while (std::getline(std::cin, line)) {
                auto request = Json::parse(line);
                if (!request.contains("id"))
                    continue;
                const auto method = request.value("method", "");
                Json result;
                if (method == "initialize")
                    result = {{"codexHome", "fixture"}};
                else if (method == "test/timeout") {
                    continue;
                } else if (method == "test/exit") {
                    return 0;
                } else if (method == "test/notification") {
                    std::cout << Json({{"method", "account/rateLimits/updated"}}).dump() << std::endl;
                    result = Json::object();
                } else if (method == "test/environment")
                    result = {{"workers", utf8(environment(L"TOKIO_WORKER_THREADS"))}};
                else if (method == "test/malformed") {
                    std::cout << "not-json\n";
                    result = Json::object();
                } else
                    result = {{"rateLimits",
                               {{"limitId", "codex"},
                                {"primary",
                                 {{"usedPercent", 25},
                                  {"windowDurationMins", 120},
                                  {"resetsAt", now() / 1000 + 3600}}}}}};
                std::cout << Json({{"id", request["id"]}, {"result", result}}).dump() << std::endl;
                if (method == "test/idle-exit") {
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
                    return 0;
                }
            }
            return 0;
        }
        if (argc == 3 && std::string(argv[1]) == "--fixtures") {
            const auto cases = Json::parse(read_file(fs::path(argv[2])));
            for (const auto &c : cases) {
                Json actual;
                const auto kind = c.at("kind").get<std::string>();
                if (kind == "projection")
                    actual = projection(c["used"], c["start"], c["reset"], c["at"]);
                else if (kind == "parse")
                    actual = parse_limits(c["input"]);
                else if (kind == "snapshot")
                    actual = snapshot(c["state"], c["connection"], "", c["at"]);
                else if (kind == "observe") {
                    actual = c["state"];
                    observe(actual, c["at"]);
                } else if (kind == "segments")
                    actual = segments(c["points"], c["forecasts"]);
                else if (kind == "normalize")
                    actual = normalize_state(c["input"]);
                else
                    throw std::runtime_error("Unknown fixture kind");
                if (actual != c["expected"]) {
                    std::cerr << c["name"] << "\nactual: " << actual.dump()
                              << "\nexpected: " << c["expected"].dump() << '\n';
                    return 1;
                }
                ++assertions;
            }
            std::cout << assertions << " parity cases passed\n";
            return 0;
        }
        require(timestamp("2026-09-25T00:00:00.000Z").has_value(), "ISO parse");
        const auto at = *timestamp("2026-09-25T00:00:00.000Z");
        require(iso(at) == "2026-09-25T00:00:00.000Z", "ISO roundtrip");
        require(percent(22.5) == "23%", "percentage half rounds up");
        require(percent(1234.56, true) == "1,234.6%", "forecast formatting");
        require(timestamp("2026-09-25T08:00:00+08:00") == at, "timezone offset");
        require(!timestamp("2026-02-30T00:00:00Z"), "reject invalid dates");
        std::vector<MonitorSpace> monitors{
            {{0, 0, 1920, 1080}, 1.5}, {{1920, 0, 4480, 1440}, 2}, {{-1920, 0, 0, 1080}, 1}};
        layout_monitors(monitors);
        require(monitors[1].dips.left == 1280 && monitors[2].dips.left == -1920,
                "mixed DPI monitor origins remain adjacent");
        for (const auto &monitor : monitors) {
            POINT original_point{monitor.pixels.left + 900, monitor.pixels.top + 300};
            auto point = original_point;
            for (int repeat = 0; repeat < 20; ++repeat)
                point = convert_point(convert_point(point, monitor, false), monitor, true);
            require(point.x == original_point.x && point.y == original_point.y,
                    "DPI position does not drift across restarts");
        }
        std::vector<MonitorSpace> end_aligned{{{0, 0, 1920, 1080}, 1.5}, {{1920, -360, 4480, 1080}, 2}};
        layout_monitors(end_aligned);
        require(end_aligned[1].dips.top == 0 && end_aligned[1].dips.bottom == 720, "mixed DPI end alignment");
        std::vector<MonitorSpace> overlap{{{0, 0, 1920, 1080}, 2, {}, L"primary"},
                                          {{1920, 0, 3840, 1080}, 1, {}, L"right"},
                                          {{0, 1080, 1920, 2160}, 1, {}, L"below"}};
        layout_monitors(overlap);
        RECT below_window{1500, 1380, 1840, 1468};
        auto saved_position = encode_position(below_window, overlap);
        require(saved_position["x"] == 1500 && saved_position["y"] == 840,
                "legacy DIP position preserved with native monitor anchor");
        for (int repeat = 0; repeat < 20; ++repeat) {
            auto restored = decode_position(saved_position, {340, 88}, overlap);
            require(restored.x == 1500 && restored.y == 1380,
                    "overlapping DIP monitors restore to the original physical monitor");
            saved_position =
                encode_position({restored.x, restored.y, restored.x + 340, restored.y + 88}, overlap);
        }
        auto legacy_position = saved_position;
        legacy_position.erase("nativeAnchor");
        auto legacy_restored = decode_position(legacy_position, {380, 500}, overlap);
        require(legacy_restored.x == 1500 && legacy_restored.y == 1380,
                "legacy position uses window rectangle overlap, not first matching point");
        auto removed_monitor = overlap;
        removed_monitor.pop_back();
        auto fallback = decode_position(saved_position, {340, 88}, removed_monitor);
        require(fallback.x == 2460 && fallback.y == 840,
                "removed monitor falls back to available DIP layout");
        require(projection(25, at - 3600000, at + 3600000, at)["projectedUsedPercent"] == 50, "projection");
        require(projection(nullptr, at - 1, at + 1, at)["status"] == "unavailable", "missing is not zero");
        const Millis hour = 3600000, week = 168 * hour;
        require(early_forecast(at, at + week, at + 6 * hour - 1), "early until six hours");
        require(!early_forecast(at, at + week, at + 6 * hour), "six hour boundary included");
        require(!early_forecast(at, at + week, at + 6 * hour + 1), "after boundary included");
        require(!early_forecast(at, at + 6 * hour, at + hour), "six hour windows unchanged");
        require(!early_forecast(at, at + hour, at + 60000), "short windows unchanged");
        auto weekly = defaults();
        weekly["rateLimits"] = parse_limits({{"rateLimits", {{"limitId", "codex"},
            {"primary", {{"usedPercent", 2}, {"windowDurationMins", 10080},
                         {"resetsAt", (at + week) / 1000}}}}}});
        const Millis spike_at = at + 2863766;
        weekly["rateLimitsSyncedAt"] = iso(spike_at);
        observe(weekly, spike_at);
        auto early_view = snapshot(weekly, "online", "", spike_at);
        auto early_display = trend_display(early_view);
        require(early_view["reset"]["projection"]["projectedUsedPercent"] == 422.4,
                "raw early card forecast unchanged");
        require(early_display.ceiling == 100 && early_display.projected.is_null() &&
                    segments(early_display.forecasts, true).empty() && early_display.points.size() == 1,
                "early spike keeps observed point without forecast or endpoint or inflated axis");
        require(early_display.points[0]["projectedUsedPercent"] == 422.4,
                "raw early forecast available to tooltip");
        require(trend_display(snapshot(normalize_state(weekly), "online", "", spike_at)).ceiling == 100,
                "loaded historical spike is filtered without restart warmup");
        const auto saved_weekly = weekly;
        trend_display(early_view);
        require(weekly == saved_weekly, "presentation leaves stored history unchanged");
        weekly["rateLimitsSyncedAt"] = iso(at + 6 * hour);
        observe(weekly, at + 6 * hour);
        auto mature_view = snapshot(weekly, "online", "", at + 6 * hour);
        auto mature_display = trend_display(mature_view);
        require(mature_display.projected == 56 && segments(mature_display.forecasts, true).size() == 1 &&
                    mature_display.points.size() == 2, "forecast begins on first six hour reading");
        mature_view["reset"]["observations"].push_back(
            {{"at", iso(at + 7 * hour)}, {"usedPercent", 5}, {"projectedUsedPercent", 118.5}});
        mature_view["reset"]["projection"]["projectedUsedPercent"] = 117.4;
        require(trend_display(mature_view).ceiling == 125, "historical early peak no longer expands mature axis");
        require(segments(trend_display(mature_view).forecasts, true).size() == 2, "forecast gaps preserved");
        auto offline_display = trend_display(snapshot(weekly, "offline", "", at + 6 * hour));
        require(offline_display.projected.is_null() && !segments(offline_display.forecasts, true).empty(),
                "offline retains eligible history without endpoint");
        early_view["generatedAt"] = iso(at + 6 * hour);
        require(trend_display(early_view).projected.is_null(), "old early reading cannot unlock endpoint by wall clock");
        mature_view["reset"]["observations"][1].erase("projectedUsedPercent");
        require(segments(trend_display(mature_view).forecasts, true).size() == 1,
                "legacy missing forecast is not invented");
        weekly["rateLimits"][0]["primary"]["resetsAt"] = (at + 2 * week) / 1000;
        weekly["rateLimits"][0]["primary"]["usedPercent"] = 0;
        weekly["rateLimitsSyncedAt"] = iso(at + week + hour);
        observe(weekly, at + week + hour);
        auto next_display = trend_display(snapshot(weekly, "online", "", at + week + hour));
        require(next_display.points.size() == 1 && next_display.points[0]["usedPercent"] == 0 &&
                    next_display.projected.is_null(), "new cycle filters forecasts and preserves actual zero");
        auto state = defaults();
        state["rateLimits"] = parse_limits(
            {{"rateLimits",
              {{"limitId", "codex"},
               {"primary",
                {{"usedPercent", 25}, {"windowDurationMins", 120}, {"resetsAt", (at + 3600000) / 1000}}}}}});
        state["rateLimitsSyncedAt"] = iso(at);
        observe(state, at);
        observe(state, at + 1000);
        require(state["quotaHistory"]["observations"].size() == 1, "one observation per minute");
        observe(state, at + 60000);
        require(state["quotaHistory"]["observations"].size() == 2, "new minute");
        require(snapshot(state, "offline", "", at)["reset"]["projection"]["status"] == "unavailable",
                "offline projection");
        require(snapshot(state, "online", "", at + 3600000)["reset"]["usedPercent"].is_null(),
                "expired quota");
        require(snapshot(state, "online", "", at + 120001)["stale"] == true, "staleness deadline");
        auto normalized = normalize_state(state);
        require(normalized == state, "normalization roundtrip");
        state["quotaHistory"]["observations"][0].erase("projectedUsedPercent");
        require(!normalize_state(state)["quotaHistory"]["observations"][0].contains("projectedUsedPercent"),
                "missing forecast preserved");
        state["quotaHistory"]["observations"][1]["projectedUsedPercent"] = nullptr;
        require(normalize_state(state)["quotaHistory"]["observations"][1]["projectedUsedPercent"].is_null(),
                "null forecast preserved");
        auto long_history = state;
        long_history["quotaHistory"]["windowDurationMins"] = 10080;
        auto &observations = long_history["quotaHistory"]["observations"];
        observations = Json::array();
        for (int i = 0; i < 10090; ++i)
            observations.push_back({{"at", iso(at - 10090 + i)}, {"usedPercent", 25}});
        require(normalize_state(long_history)["quotaHistory"]["observations"].size() == max_observations,
                "history is bounded to 10080 observations");
        const auto folder =
            fs::temp_directory_path() / (L"codex-native-test-" + std::to_wstring(GetCurrentProcessId()));
        fs::create_directories(folder);
        const auto file = folder / L"quota-state.json";
        const auto legacy = folder / L"usage-state.json";
        const Json legacy_state{{"version", 1},
                                {"settings", {{"expanded", true}}},
                                {"sessions", Json::object()},
                                {"account", Json::object()},
                                {"priceBook", Json::object()}};
        {
            std::ofstream out(legacy);
            out << legacy_state.dump();
        }
        auto migrated = Store(file).load();
        require(migrated["settings"]["expanded"] == true && migrated["settings"]["alwaysOnTop"] == true &&
                    migrated["window"]["x"].is_null(),
                "legacy partial settings inherit defaults");
        require(read_file(legacy) == legacy_state.dump(), "legacy source is unchanged");
        const auto generations = fs::path(legacy.wstring() + L".generations");
        fs::create_directories(generations);
        const std::string invalid_generation = R"({"settings":{}})";
        {
            std::ofstream out(generations / L"bad.json");
            out << invalid_generation;
        }
        auto previous = legacy_state;
        previous["settings"]["expanded"] = false;
        {
            std::ofstream out(generations / L"previous.json");
            out << previous.dump();
        }
        {
            std::ofstream out(fs::path(legacy.wstring() + L".manifest.json"));
            out << Json({{"schemaVersion", 2},
                         {"active", {{"file", "bad.json"}, {"sha256", sha256(invalid_generation)}}},
                         {"previous", {{"file", "previous.json"}, {"sha256", sha256(previous.dump())}}}})
                       .dump();
        }
        require(Store(file).load()["settings"]["expanded"] == false,
                "invalid legacy active generation falls back to previous");
        Store store(file);
        store.load();
        store.save(state);
        const auto original = read_file(file);
        state["settings"]["expanded"] = true;
        store.save(state);
        require(read_file(fs::path(file.wstring() + L".pre-native.bak")) == original,
                "backup exact original");
        Store reloaded(file);
        require(reloaded.load() == state, "atomic persistence");
        Handle locked(CreateFileW(file.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING,
                                  FILE_ATTRIBUTE_NORMAL, nullptr));
        state["settings"]["expanded"] = false;
        bool failed = false;
        try {
            store.save(state);
        } catch (...) {
            failed = true;
        }
        require(failed, "write failure reported");
        locked.reset();
        require(reloaded.load()["settings"]["expanded"] == true, "write failure preserves original");
        {
            std::ofstream out(file);
            out << "{broken json";
        }
        bool corrupt = false;
        try {
            Store(file).load();
        } catch (...) {
            corrupt = true;
        }
        require(corrupt && read_file(file) == "{broken json", "corrupt quota JSON is reported and preserved");
        fs::remove_all(folder);
        require(sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                "SHA256");
        std::atomic_bool stopped = false;
        Server server(stopped);
        wchar_t self[32768];
        GetModuleFileNameW(nullptr, self, 32768);
        server.start(self);
        require(server.running(), "mock App Server initialized");
        require(server.request("test/environment")["workers"] == "2", "child worker limit");
        require(parse_limits(server.request("account/rateLimits/read")).size() == 1, "quota read");
        server.request("test/notification");
        require(server.changed(), "quota notification");
        server.request("test/malformed");
        require(server.running(), "invalid protocol line tolerated");
        bool timeout = false;
        try {
            server.request("test/timeout", nullptr, 100);
        } catch (...) {
            timeout = true;
        }
        require(timeout, "request timeout");
        const DWORD child = server.pid();
        Handle child_handle(OpenProcess(SYNCHRONIZE, FALSE, child));
        server.stop();
        require(WaitForSingleObject(child_handle.get(), 1000) == WAIT_OBJECT_0, "child cleaned on stop");
        server.start(self);
        server.request("test/idle-exit");
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        bool idle_exited = false;
        try {
            if (server.pid())
                server.changed();
        } catch (...) {
            idle_exited = true;
        }
        require(idle_exited, "idle child exit detected by notification polling");
        server.stop();
        server.start(self);
        bool exited = false;
        try {
            server.request("test/exit");
        } catch (...) {
            exited = true;
        }
        require(exited, "child exit detected");
        server.stop();
        server.start(self);
        std::thread cancel([&] {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            stopped = true;
        });
        bool cancelled = false;
        try {
            server.request("test/timeout");
        } catch (...) {
            cancelled = true;
        }
        cancel.join();
        server.stop();
        require(cancelled, "shutdown cancels pending request");
        std::cout << assertions << " assertions passed\n";
        return 0;
    } catch (const std::exception &failure) {
        std::cerr << failure.what() << '\n';
        return 1;
    }
}
