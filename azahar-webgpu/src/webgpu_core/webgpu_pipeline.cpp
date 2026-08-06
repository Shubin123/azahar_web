#include "webgpu_pipeline.h"   // contains Pipeline class declaration
#include "webgpu_device.h"     // contains full Device definition
#include "webgpu_shader.h"     // contains full ShaderModule definition
#include <cassert>
#include <cstring>

namespace WebGPU {   // <- IMPORTANT: wrap everything in WebGPU namespace

Pipeline::Pipeline(Pipeline&& other) noexcept
    : pipeline_(other.pipeline_) {
    other.pipeline_ = nullptr;
}

Pipeline& Pipeline::operator=(Pipeline&& other) noexcept {
    if (this != &other) {
        Reset();
        pipeline_ = other.pipeline_;
        other.pipeline_ = nullptr;
    }
    return *this;
}

Pipeline::~Pipeline() {
    Reset();
}

void Pipeline::Reset() {
    if (pipeline_) {
        wgpuRenderPipelineRelease(pipeline_);
        pipeline_ = nullptr;
    }
}

bool Pipeline::CreateGraphics(
    Device& device,
    const ShaderModule& shader,
    const char* vertex_entry,
    const char* fragment_entry
) {
    Reset();

    assert(device.IsValid());
    assert(shader.IsValid());

    // Vertex stage
    WGPUVertexState vertex_state = {};
    vertex_state.module = shader.GetHandle();
    vertex_state.entryPoint = vertex_entry;
    vertex_state.bufferCount = 0;
    vertex_state.buffers = nullptr;

    // Fragment stage
    WGPUColorTargetState color_target = {};
    color_target.format = WGPUTextureFormat_BGRA8Unorm;
    color_target.writeMask = WGPUColorWriteMask_All;

    WGPUFragmentState fragment_state = {};
    fragment_state.module = shader.GetHandle();
    fragment_state.entryPoint = fragment_entry;
    fragment_state.targetCount = 1;
    fragment_state.targets = &color_target;

    // Primitive state
    WGPUPrimitiveState primitive = {};
    primitive.topology = WGPUPrimitiveTopology_TriangleList;
    primitive.frontFace = WGPUFrontFace_CCW;
    primitive.cullMode = WGPUCullMode_None;

    // Multisample state
    WGPUMultisampleState multisample = {};
    multisample.count = 1;
    multisample.mask = 0xFFFFFFFF;
    multisample.alphaToCoverageEnabled = false;

    // Pipeline descriptor
    WGPURenderPipelineDescriptor desc = {};
    desc.vertex = vertex_state;
    desc.fragment = &fragment_state;
    desc.primitive = primitive;
    desc.multisample = multisample;
    desc.layout = nullptr;

    pipeline_ = wgpuDeviceCreateRenderPipeline(device.GetHandle(), &desc);
    return pipeline_ != nullptr;
}

} // namespace WebGPU
