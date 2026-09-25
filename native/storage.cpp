#include "platform.hpp"
#include <bcrypt.h>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace overlay {
std::wstring wide(const std::string &text) {
    if (text.empty())
        return {};
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                                     static_cast<int>(text.size()), nullptr, 0);
    if (!length)
        throw std::runtime_error("Invalid UTF-8");
    std::wstring result(length, 0);
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), length);
    return result;
}
std::string utf8(const std::wstring &text) {
    if (text.empty())
        return {};
    int length = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0,
                                     nullptr, nullptr);
    std::string result(length, 0);
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), length,
                        nullptr, nullptr);
    return result;
}
std::wstring environment(const wchar_t *name) {
    DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
    if (!size)
        return {};
    std::wstring value(size, 0);
    GetEnvironmentVariableW(name, value.data(), size);
    value.resize(size - 1);
    return value;
}
std::string read_file(const fs::path &path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream)
        throw std::runtime_error("Unable to read " + utf8(path.wstring()));
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
std::string sha256(const std::string &bytes) {
    BCRYPT_ALG_HANDLE alg{};
    BCRYPT_HASH_HANDLE hash{};
    unsigned char digest[32]{};
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0)
        throw std::runtime_error("SHA-256 unavailable");
    NTSTATUS status = BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0);
    if (status >= 0)
        status = BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char *>(bytes.data())),
                                static_cast<ULONG>(bytes.size()), 0);
    if (status >= 0)
        status = BCryptFinishHash(hash, digest, sizeof(digest), 0);
    if (hash)
        BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(alg, 0);
    if (status < 0)
        throw std::runtime_error("SHA-256 failed");
    std::ostringstream out;
    for (auto byte : digest)
        out << std::hex << std::setw(2) << std::setfill('0') << unsigned(byte);
    return out.str();
}
Json Store::load() {
    if (fs::exists(path_)) {
        const auto bytes = read_file(path_);
        auto result = normalize_state(Json::parse(bytes));
        saved_ = result.dump();
        return result;
    }
    auto state = defaults();
    const auto legacy = path_.parent_path() / L"usage-state.json";
    const auto state_like = [](const Json &value) {
        if (!value.is_object() ||
            (value.value("version", Json()) != 1 && value.value("version", Json()) != 2))
            return false;
        for (const auto key : {"settings", "sessions", "account", "priceBook"})
            if (!value.value(key, Json()).is_object())
                return false;
        return true;
    };
    Json old;
    try {
        const auto manifest = Json::parse(read_file(fs::path(legacy.wstring() + L".manifest.json")));
        if (!manifest.is_object() || manifest.value("schemaVersion", Json()) != 2 ||
            !manifest.value("active", Json()).is_object())
            throw std::runtime_error("Invalid legacy manifest");
        for (const auto key : {"active", "previous"}) {
            if (!manifest.contains(key))
                continue;
            try {
                const auto pointer = manifest.at(key);
                const auto bytes = read_file(fs::path(legacy.wstring() + L".generations") /
                                             fs::path(wide(pointer.at("file"))).filename());
                if (sha256(bytes) == pointer.at("sha256").get<std::string>()) {
                    auto value = Json::parse(bytes);
                    if (state_like(value)) {
                        old = value;
                        break;
                    }
                }
            } catch (const std::exception &) {
            }
        }
    } catch (const std::exception &) {
    }
    if (old.is_null() && fs::exists(legacy)) {
        try {
            auto candidate = Json::parse(read_file(legacy));
            if (state_like(candidate))
                old = std::move(candidate);
        } catch (const std::exception &) {
        }
    }
    if (old.is_object()) {
        for (const auto key : {"settings", "window"})
            if (old.value(key, Json()).is_object())
                state[key].update(old[key]);
        if (old.value("rateLimits", Json()).is_array())
            state["rateLimits"] = old["rateLimits"];
        if (timestamp(old.value("rateLimitsSyncedAt", Json())))
            state["rateLimitsSyncedAt"] = old["rateLimitsSyncedAt"];
        state = normalize_state(state);
    }
    return state;
}
void Store::save(const Json &state) {
    const auto bytes = state.dump();
    if (bytes == saved_)
        return;
    fs::create_directories(path_.parent_path());
    const fs::path backup = path_.wstring() + L".pre-native.bak";
    if (fs::exists(path_) && !fs::exists(backup)) {
        if (!CopyFileW(path_.c_str(), backup.c_str(), TRUE))
            throw std::runtime_error("Unable to back up quota state; original file preserved.");
    }
    const fs::path temporary =
        path_.wstring() + L".native-" + std::to_wstring(GetCurrentProcessId()) + L".tmp";
    Handle output(CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                              FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!output)
        throw std::runtime_error("Unable to create temporary quota state.");
    DWORD written{};
    const auto length = static_cast<DWORD>(bytes.size());
    const bool ok = WriteFile(output.get(), bytes.data(), length, &written, nullptr) && written == length &&
                    FlushFileBuffers(output.get());
    output.reset();
    if (!ok) {
        DeleteFileW(temporary.c_str());
        throw std::runtime_error("Unable to write quota state; original file preserved.");
    }
    const BOOL replaced = fs::exists(path_)
                              ? ReplaceFileW(path_.c_str(), temporary.c_str(), nullptr, 0, nullptr, nullptr)
                              : MoveFileExW(temporary.c_str(), path_.c_str(), MOVEFILE_WRITE_THROUGH);
    if (!replaced) {
        DeleteFileW(temporary.c_str());
        throw std::runtime_error("Unable to replace quota state; original file preserved.");
    }
    saved_ = bytes;
}
} // namespace overlay
