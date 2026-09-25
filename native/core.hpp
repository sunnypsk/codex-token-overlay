#pragma once
#include <chrono>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace overlay {
using Json = nlohmann::json;
using Millis = long long;
constexpr size_t max_observations = 10080;
Millis now();
std::optional<Millis> timestamp(const Json &value);
std::string iso(Millis ms);
bool number(const Json &value);
Json defaults();
Json parse_limits(const Json &response);
Json projection(const Json &used, const Json &start, const Json &reset, Millis at);
bool same_cycle(const Json &history, const std::string &id, const Json &window);
Json normalize_state(const Json &input);
void observe(Json &state, Millis at);
Json snapshot(const Json &state, const std::string &connection, const std::string &error, Millis at);
std::vector<std::vector<Json>> segments(const Json &points, bool forecasts);
std::string percent(const Json &value, bool decimal = false);
std::string countdown(Millis reset, Millis at);
std::string hkt(Millis at);
} // namespace overlay
