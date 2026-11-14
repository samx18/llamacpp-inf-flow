cmake_minimum_required(VERSION 3.16)
project(llamacpp_inf_flow_tracer CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if (NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# CPU backend only (PLAN.md "Settings to fix"). No Metal, no BLAS backend,
# so llama-simple, llama-eval-callback and the tracer all run the same CPU path.
set(GGML_METAL       OFF CACHE BOOL "" FORCE)
set(GGML_BLAS        OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE      ON  CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

# Reference examples used by the acceptance checks (llama-eval-callback, llama-simple).
set(LLAMA_BUILD_COMMON   ON  CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES ON  CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP      OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL        OFF CACHE BOOL "" FORCE)

add_subdirectory(third_party/llama.cpp)

# llama.cpp commit and tag, reported in the model_info event.
set(LLAMA_SRC ${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp)
execute_process(COMMAND git -C ${LLAMA_SRC} rev-parse --short=9 HEAD
                OUTPUT_VARIABLE LLAMACPP_COMMIT OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
execute_process(COMMAND git -C ${LLAMA_SRC} describe --tags --exact-match HEAD
                OUTPUT_VARIABLE LLAMACPP_TAG OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)

if (EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/tracer.cpp)
    add_executable(tracer tracer.cpp)
    target_link_libraries(tracer PRIVATE llama ggml)
    target_compile_definitions(tracer PRIVATE
        LLAMACPP_COMMIT="${LLAMACPP_COMMIT}" LLAMACPP_TAG="${LLAMACPP_TAG}")
    set_target_properties(tracer PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
endif()
