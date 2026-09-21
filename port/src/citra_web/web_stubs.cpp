// SPDX-License-Identifier: GPL-2.0-or-later
//
// Platform gaps that only appear on an Emscripten target.

#include <pthread.h>

extern "C" {

/// Emscripten declares pthread_setname_np in <pthread.h> but does not provide
/// it in the pthreads libc variant, so citra_core's fs_user.cpp fails to link.
/// Thread names are a debugging aid only; accepting and discarding the name
/// keeps behaviour identical everywhere it matters.
int pthread_setname_np(pthread_t thread, const char* name) {
    (void)thread;
    (void)name;
    return 0;
}

} // extern "C"
