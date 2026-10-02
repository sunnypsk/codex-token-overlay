#include "platform.hpp"
#include <cmath>
#include <stdexcept>

namespace overlay {
namespace {
Json field(const Json &v, const char *key) {
    return v.is_object() ? v.value(key, Json()) : Json();
}
bool valid_percent(const Json &v) {
    return number(v) && v.get<double>() >= 0 && v.get<double>() <= 100;
}
bool valid_cache(const Json &v) {
    return field(v, "schemaVersion") == 1 && valid_percent(field(v, "usedPercent")) &&
           timestamp(field(v, "receivedAt")) &&
           (field(v, "resetsAt").is_null() || timestamp(v["resetsAt"]));
}
std::string small_file(const fs::path &path) {
    Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    LARGE_INTEGER length{};
    if (!file || !GetFileSizeEx(file.get(), &length) || length.QuadPart < 0 || length.QuadPart > 16384)
        throw std::runtime_error("Unable to read Claude usage cache.");
    std::string bytes(static_cast<size_t>(length.QuadPart), '\0');
    DWORD read{};
    if (!ReadFile(file.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) || read != bytes.size())
        throw std::runtime_error("Unable to read Claude usage cache.");
    return bytes;
}
void output_line(DWORD stream, const std::string &message) {
    const auto handle = GetStdHandle(stream);
    DWORD written{};
    if (handle && handle != INVALID_HANDLE_VALUE)
        WriteFile(handle, message.data(), static_cast<DWORD>(message.size()), &written, nullptr);
}
} // namespace

Json claude_sample(const Json &input, Millis received_at) {
    const auto window = field(field(input, "rate_limits"), "five_hour");
    const auto used = field(window, "used_percentage"), reset = field(window, "resets_at");
    if (!valid_percent(used))
        return nullptr;
    Json reset_time = nullptr;
    if (!reset.is_null()) {
        if (!number(reset) || reset.get<double>() <= received_at / 1000.0 || reset.get<double>() > 4102444800.0)
            return nullptr;
        reset_time = iso(static_cast<Millis>(reset.get<double>() * 1000));
    }
    return {{"schemaVersion", 1}, {"usedPercent", used}, {"resetsAt", reset_time},
            {"receivedAt", iso(received_at)}};
}
Json claude_snapshot(const Json &sample, Millis at) {
    const bool valid = valid_cache(sample);
    const auto received = timestamp(field(sample, "receivedAt")), reset = timestamp(field(sample, "resetsAt"));
    const bool expired = reset && *reset <= at;
    return {{"enabled", !sample.is_null()},
            {"usedPercent", valid && !expired ? sample["usedPercent"] : Json()},
            {"resetsAt", valid && !expired ? field(sample, "resetsAt") : Json()},
            {"receivedAt", valid ? sample["receivedAt"] : Json()},
            {"stale", !valid || !received || *received > at || at - *received > 300000},
            {"expired", expired}};
}
std::string claude_line(const Json &view, Millis at) {
    std::string line = "Claude 5h: " + percent(view["usedPercent"]);
    if (const auto reset = timestamp(view["resetsAt"]))
        line += " | Reset in " + countdown(*reset, at);
    if (view["stale"].get<bool>() && number(view["usedPercent"]))
        line += " | Last synced";
    if (view["expired"].get<bool>())
        line += " | Window ended";
    return line;
}
Json ClaudeReader::read() {
    try {
        if (!fs::exists(path_)) {
            bytes_.clear();
            sample_ = nullptr;
            return sample_;
        }
        const auto bytes = small_file(path_);
        if (bytes_ == bytes && !bytes_.empty())
            return sample_;
        const auto candidate = Json::parse(bytes);
        const bool empty = field(candidate, "schemaVersion") == 1 && field(candidate, "usedPercent").is_null() &&
                           field(candidate, "receivedAt").is_null();
        if (!valid_cache(candidate) && !empty)
            throw std::runtime_error("Invalid Claude usage cache.");
        sample_ = candidate;
        bytes_ = bytes;
    } catch (const std::exception &) {
        // A transient read or malformed replacement must not erase the last valid reading.
        if (sample_.is_null())
            sample_ = {{"schemaVersion", 1}};
    }
    return sample_;
}
bool write_claude_sample(const fs::path &profile, const Json &sample) {
    if (!valid_cache(sample))
        return false;
    fs::create_directories(profile);
    const auto name = L"Local\\CodexTokenOverlayClaude-" + wide(sha256(utf8(fs::weakly_canonical(profile).wstring())).substr(0, 16));
    Handle mutex(CreateMutexW(nullptr, FALSE, name.c_str()));
    if (!mutex)
        throw std::runtime_error("Unable to coordinate Claude usage writers.");
    const auto acquired = WaitForSingleObject(mutex.get(), 2000);
    if (acquired != WAIT_OBJECT_0 && acquired != WAIT_ABANDONED)
        throw std::runtime_error("Claude usage writer is busy.");
    struct Release {
        HANDLE handle;
        ~Release() { ReleaseMutex(handle); }
    } release{mutex.get()};
    const auto path = profile / L"claude-usage.json";
    try {
        const auto previous = Json::parse(small_file(path));
        if (valid_cache(previous) && *timestamp(previous["receivedAt"]) >= *timestamp(sample["receivedAt"]))
            return false;
    } catch (const std::exception &) {
    }
    const fs::path temporary = path.wstring() + L"." + std::to_wstring(GetCurrentProcessId()) + L"-" +
                              std::to_wstring(GetTickCount64()) + L".tmp";
    const auto bytes = sample.dump();
    Handle file(CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file)
        throw std::runtime_error("Unable to create Claude usage cache.");
    DWORD written{};
    const bool ok = WriteFile(file.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
                    written == bytes.size() && FlushFileBuffers(file.get());
    file.reset();
    if (!ok || !MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(temporary.c_str());
        throw std::runtime_error("Unable to save Claude usage cache; previous reading preserved.");
    }
    return true;
}
int claude_statusline(const fs::path &profile) {
    try {
        const auto received = now();
        std::string input;
        char buffer[4096];
        DWORD length{};
        const auto pipe = GetStdHandle(STD_INPUT_HANDLE);
        while (ReadFile(pipe, buffer, sizeof(buffer), &length, nullptr) && length) {
            if (input.size() + length > 1024 * 1024)
                throw std::runtime_error("Status line input is too large.");
            input.append(buffer, length);
        }
        const auto parsed = Json::parse(input, nullptr, false);
        const auto sample = claude_sample(parsed, received);
        if (!sample.is_null())
            write_claude_sample(profile, sample);
        ClaudeReader reader(profile);
        output_line(STD_OUTPUT_HANDLE, claude_line(claude_snapshot(reader.read(), now()), now()) + "\n");
        return 0;
    } catch (const std::exception &) {
        output_line(STD_OUTPUT_HANDLE, "Claude 5h: N/A\n");
        output_line(STD_ERROR_HANDLE, "Unable to update Claude usage cache.\n");
        return 1;
    }
}
} // namespace overlay
