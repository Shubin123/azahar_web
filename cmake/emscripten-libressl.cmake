# Injected into the bundled LibreSSL subproject with
# -DCMAKE_PROJECT_LibreSSL_INCLUDE, so the upstream tree stays unmodified.
#
# LibreSSL picks its entropy backend by platform macro in
# crypto/compat/arc4random.h, which knows AIX, FreeBSD, HP-UX, Linux, NetBSD,
# macOS, Solaris and Windows, and otherwise stops the build with
# "No arc4random hooks defined for this platform." Emscripten defines
# __EMSCRIPTEN__ and __unix__ but not __linux__, so it lands in that #error.
#
# arc4random_linux.h needs only getentropy(), sys/mman.h, pthread.h and
# signal.h, all of which Emscripten provides, and its glibc-only branch is
# guarded by __GLIBC__, which is absent under musl. So the Linux hook is the
# correct one here.
#
# Scoping note: __linux__ appears in exactly two places in this tree — this
# header, and amd64 .S files that are never assembled for wasm. Defining it for
# the subproject therefore changes only the entropy-backend choice.
if (EMSCRIPTEN)
    add_compile_definitions(__linux__=1)
    message(STATUS "Web shim: LibreSSL built with the Linux getentropy backend")
endif()
