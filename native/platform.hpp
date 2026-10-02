#pragma once
#include "core.hpp"
#include <atomic>
#include <filesystem>
#include <mutex>
#include <windows.h>

namespace overlay {
namespace fs = std::filesystem;
std::wstring wide(const std::string &text);
std::string utf8(const std::wstring &text);
std::wstring environment(const wchar_t *name);
std::string read_file(const fs::path &path);
std::string sha256(const std::string &bytes);
struct MonitorSpace {
    RECT pixels;
    double scale;
    RECT dips{};
    std::wstring device;
};
void layout_monitors(std::vector<MonitorSpace> &monitors);
POINT convert_point(POINT point, const MonitorSpace &monitor, bool to_pixels);
Json encode_position(RECT window, const std::vector<MonitorSpace> &monitors);
POINT decode_position(const Json &window, SIZE size, const std::vector<MonitorSpace> &monitors);
Json capture_position(HWND window);
POINT restore_position(const Json &window, SIZE size);
class Handle {
    HANDLE value_ = nullptr;

  public:
    Handle() = default;
    explicit Handle(HANDLE value) : value_(value) {}
    ~Handle() {
        reset();
    }
    Handle(const Handle &) = delete;
    Handle &operator=(const Handle &) = delete;
    Handle(Handle &&other) noexcept : value_(other.release()) {}
    Handle &operator=(Handle &&other) noexcept {
        if (this != &other)
            reset(other.release());
        return *this;
    }
    void reset(HANDLE value = nullptr) {
        if (value_ && value_ != INVALID_HANDLE_VALUE)
            CloseHandle(value_);
        value_ = value;
    }
    HANDLE get() const {
        return value_;
    }
    HANDLE release() {
        const auto value = value_;
        value_ = nullptr;
        return value;
    }
    explicit operator bool() const {
        return value_ && value_ != INVALID_HANDLE_VALUE;
    }
};
class Store {
    fs::path path_;
    std::string saved_;

  public:
    explicit Store(fs::path path) : path_(std::move(path)) {}
    Json load();
    void save(const Json &state);
};
fs::path find_codex();
class ClaudeReader {
    fs::path path_;
    std::string bytes_;
    Json sample_;
  public:
    explicit ClaudeReader(fs::path profile) : path_(std::move(profile) / L"claude-usage.json") {}
    Json read();
};
bool write_claude_sample(const fs::path &profile, const Json &sample);
int claude_statusline(const fs::path &profile);
class Server {
    Handle job_, process_, input_, output_, error_;
    std::string buffer_;
    unsigned next_id_ = 1;
    bool changed_ = false;
    std::atomic_bool *stopped_;
    void write(const Json &message);
    std::optional<Json> read(unsigned wait_ms);

  public:
    explicit Server(std::atomic_bool &stopped) : stopped_(&stopped) {}
    ~Server() {
        stop();
    }
    void start(const fs::path &path);
    void stop();
    Json request(const std::string &method, Json params = nullptr, unsigned timeout_ms = 15000);
    bool changed();
    bool running() const;
    DWORD pid() const {
        return process_ ? GetProcessId(process_.get()) : 0;
    }
};
} // namespace overlay
