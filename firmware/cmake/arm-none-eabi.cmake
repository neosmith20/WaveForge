set(CMAKE_SYSTEM_NAME      Generic)
set(CMAKE_SYSTEM_PROCESSOR ARM)

set(TRIPLE arm-none-eabi)

# Locate the toolchain binaries; fail fast if they are not on PATH.
find_program(CMAKE_C_COMPILER   ${TRIPLE}-gcc     REQUIRED)
find_program(CMAKE_CXX_COMPILER ${TRIPLE}-g++     REQUIRED)
find_program(CMAKE_ASM_COMPILER ${TRIPLE}-gcc     REQUIRED)
find_program(CMAKE_OBJCOPY      ${TRIPLE}-objcopy REQUIRED)
find_program(CMAKE_SIZE         ${TRIPLE}-size    REQUIRED)

set(CMAKE_OBJCOPY ${CMAKE_OBJCOPY} CACHE INTERNAL "")
set(CMAKE_SIZE    ${CMAKE_SIZE}    CACHE INTERNAL "")

# Tell CMake to link test programs as static libs — the bare-metal linker
# script and startup code are not present when CMake probes the compiler.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

# Prevent CMake from adding host-side linker flags (-rdynamic etc.)
set(CMAKE_SHARED_LIBRARY_LINK_C_FLAGS   "")
set(CMAKE_SHARED_LIBRARY_LINK_CXX_FLAGS "")
