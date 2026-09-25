#include "platform.hpp"
#include <algorithm>
#include <stdexcept>
#include <thread>

namespace overlay {
fs::path find_codex() {
    std::vector<fs::path> candidates;
    const auto explicit_path = environment(L"CODEX_EXECUTABLE");
    if (!explicit_path.empty())
        candidates.emplace_back(explicit_path);
    const auto local = environment(L"LOCALAPPDATA");
    if (!local.empty()) {
        std::vector<std::pair<fs::file_time_type, fs::path>> versions;
        std::error_code ec;
        const auto root = fs::path(local) / L"OpenAI/Codex/bin";
        for (const auto &entry : fs::directory_iterator(root, ec)) {
            auto path = entry.path() / L"codex.exe";
            if (fs::is_regular_file(path, ec))
                versions.emplace_back(fs::last_write_time(path, ec), path);
        }
        std::sort(versions.rbegin(), versions.rend());
        for (const auto &item : versions)
            candidates.push_back(item.second);
    }
    const auto profile = environment(L"USERPROFILE");
    if (!profile.empty())
        candidates.emplace_back(fs::path(profile) / L".codex/.sandbox-bin/codex.exe");
    const auto path = environment(L"PATH");
    size_t pos = 0;
    while (pos < path.size()) {
        auto end = path.find(L';', pos);
        candidates.emplace_back(fs::path(path.substr(pos, end - pos)) / L"codex.exe");
        if (end == std::wstring::npos)
            break;
        pos = end + 1;
    }
    for (const auto &candidate : candidates) {
        std::error_code ec;
        auto lower = candidate.wstring();
        std::transform(lower.begin(), lower.end(), lower.begin(), towlower);
        if (lower.find(L"windowsapps") == std::wstring::npos && fs::is_regular_file(candidate, ec))
            return candidate;
    }
    throw std::runtime_error("Codex executable was not found.");
}
void Server::start(const fs::path &path) {
    stop();
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE inRead{}, inWrite{}, outRead{}, outWrite{}, errRead{}, errWrite{};
    if (!CreatePipe(&inRead, &inWrite, &sa, 0))
        throw std::runtime_error("Unable to create input pipe");
    Handle childIn(inRead);
    input_.reset(inWrite);
    if (!CreatePipe(&outRead, &outWrite, &sa, 0))
        throw std::runtime_error("Unable to create output pipe");
    Handle childOut(outWrite);
    output_.reset(outRead);
    if (!CreatePipe(&errRead, &errWrite, &sa, 0))
        throw std::runtime_error("Unable to create error pipe");
    Handle childErr(errWrite);
    error_.reset(errRead);
    for (auto handle : {input_.get(), output_.get(), error_.get()})
        SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
    job_.reset(CreateJobObjectW(nullptr, nullptr));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job_ ||
        !SetInformationJobObject(job_.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        throw std::runtime_error("Unable to create child process job");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = childIn.get();
    startup.StartupInfo.hStdOutput = childOut.get();
    startup.StartupInfo.hStdError = childErr.get();
    SIZE_T attributeSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
    std::vector<unsigned char> attributes(attributeSize);
    startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeSize))
        throw std::runtime_error("Unable to initialize child attributes");
    HANDLE inherited[]{childIn.get(), childOut.get(), childErr.get()};
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                   sizeof(inherited), nullptr, nullptr)) {
        DeleteProcThreadAttributeList(startup.lpAttributeList);
        throw std::runtime_error("Unable to restrict inherited handles");
    }
    // This child only reads quota. Avoid one Tokio worker per logical CPU;
    // preserve all authentication/configuration variables and the parent environment.
    std::vector<std::wstring> variables;
    wchar_t *inherited_environment = GetEnvironmentStringsW();
    if (!inherited_environment) {
        DeleteProcThreadAttributeList(startup.lpAttributeList);
        throw std::runtime_error("Unable to read child environment");
    }
    for (const wchar_t *entry = inherited_environment; *entry; entry += wcslen(entry) + 1) {
        if (_wcsnicmp(entry, L"TOKIO_WORKER_THREADS=", 21) != 0)
            variables.emplace_back(entry);
    }
    FreeEnvironmentStringsW(inherited_environment);
    variables.emplace_back(L"TOKIO_WORKER_THREADS=2");
    std::sort(variables.begin(), variables.end(),
              [](const auto &a, const auto &b) { return _wcsicmp(a.c_str(), b.c_str()) < 0; });
    std::vector<wchar_t> child_environment;
    for (const auto &entry : variables) {
        child_environment.insert(child_environment.end(), entry.begin(), entry.end());
        child_environment.push_back(0);
    }
    child_environment.push_back(0);
    std::wstring command = L"\"" + path.wstring() + L"\" app-server";
    PROCESS_INFORMATION process{};
    const BOOL created = CreateProcessW(path.c_str(), command.data(), nullptr, nullptr, TRUE,
                                        CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT |
                                            CREATE_UNICODE_ENVIRONMENT,
                                        child_environment.data(), nullptr, &startup.StartupInfo, &process);
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    if (!created)
        throw std::runtime_error("Unable to start Codex App Server");
    process_.reset(process.hProcess);
    Handle thread(process.hThread);
    if (!AssignProcessToJobObject(job_.get(), process_.get())) {
        TerminateProcess(process_.get(), 1);
        WaitForSingleObject(process_.get(), 2000);
        stop();
        throw std::runtime_error("Unable to contain Codex App Server");
    }
    ResumeThread(thread.get());
    childIn.reset();
    childOut.reset();
    childErr.reset();
    auto initialized =
        request("initialize",
                {{"clientInfo",
                  {{"name", "codex_token_overlay"}, {"title", "Codex Token Overlay"}, {"version", "0.2.0"}}},
                 {"capabilities",
                  {{"optOutNotificationMethods",
                    {"thread/started", "item/started", "item/completed", "item/agentMessage/delta"}}}}});
    if (!initialized.is_object() || !initialized.value("codexHome", Json()).is_string())
        throw std::runtime_error("Invalid Codex initialize response");
    write({{"method", "initialized"}, {"params", Json::object()}});
}
bool Server::running() const {
    return process_ && WaitForSingleObject(process_.get(), 0) == WAIT_TIMEOUT;
}
void Server::stop() {
    input_.reset();
    if (process_ && WaitForSingleObject(process_.get(), 500) == WAIT_TIMEOUT) {
        if (job_)
            TerminateJobObject(job_.get(), 0);
        WaitForSingleObject(process_.get(), 2000);
    }
    process_.reset();
    job_.reset();
    output_.reset();
    error_.reset();
    buffer_.clear();
    changed_ = false;
}
void Server::write(const Json &message) {
    const auto bytes = message.dump() + "\n";
    DWORD count{};
    if (!input_ ||
        !WriteFile(input_.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) ||
        count != bytes.size())
        throw std::runtime_error("Codex input pipe closed");
}
std::optional<Json> Server::read(unsigned wait_ms) {
    const auto deadline = GetTickCount64() + wait_ms;
    do {
        if (stopped_->load())
            throw std::runtime_error("Overlay stopping");
        const auto newline = buffer_.find('\n');
        if (newline != std::string::npos) {
            auto line = buffer_.substr(0, newline);
            buffer_.erase(0, newline + 1);
            auto parsed = Json::parse(line, nullptr, false);
            if (!parsed.is_discarded())
                return parsed;
            continue;
        }
        if (!running())
            throw std::runtime_error("Codex App Server exited");
        DWORD available = 0;
        char chunk[8192];
        DWORD count = 0;
        if (error_ && PeekNamedPipe(error_.get(), nullptr, 0, nullptr, &available, nullptr) && available)
            ReadFile(error_.get(), chunk, std::min<DWORD>(available, sizeof(chunk)), &count, nullptr);
        if (!PeekNamedPipe(output_.get(), nullptr, 0, nullptr, &available, nullptr))
            throw std::runtime_error("Codex output pipe closed");
        if (available) {
            if (!ReadFile(output_.get(), chunk, std::min<DWORD>(available, sizeof(chunk)), &count, nullptr))
                throw std::runtime_error("Codex output read failed");
            buffer_.append(chunk, count);
            if (buffer_.size() > 4 * 1024 * 1024)
                throw std::runtime_error("Codex response exceeded size limit");
            continue;
        }
        if (!wait_ms)
            return {};
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    } while (GetTickCount64() < deadline);
    return {};
}
Json Server::request(const std::string &method, Json params, unsigned timeout_ms) {
    const auto id = next_id_++;
    Json message{{"id", id}, {"method", method}};
    if (!params.is_null())
        message["params"] = std::move(params);
    write(message);
    const auto deadline = GetTickCount64() + timeout_ms;
    while (GetTickCount64() < deadline) {
        auto response = read(100);
        if (!response || !response->is_object())
            continue;
        if (response->value("method", Json()) == "account/rateLimits/updated")
            changed_ = true;
        if (response->value("id", Json()) != id)
            continue;
        if (response->contains("error"))
            throw std::runtime_error("Codex App Server request failed");
        return response->value("result", Json());
    }
    throw std::runtime_error(method + " timed out");
}
bool Server::changed() {
    while (auto message = read(0)) {
        if (message->is_object() && message->value("method", Json()) == "account/rateLimits/updated")
            changed_ = true;
    }
    return std::exchange(changed_, false);
}
} // namespace overlay
