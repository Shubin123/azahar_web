#ifndef WEBGPU_COMMON_H
#define WEBGPU_COMMON_H

#include <cstdio>
#include <cstdlib>

#define WEBGPU_CHECK(cond, msg) \
    if (!(cond)) { \
        fprintf(stderr, "WebGPU check failed: %s\n", msg); \
        abort(); \
    }

#endif // WEBGPU_COMMON_H
