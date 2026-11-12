# The light expert's weights

`q8/light_tower.weights` and `q8/light_adapter.weights` hold the AI player's light expert
(`scripts/nitrogen/nitrogen_light_expert.py`, written into the page's model by
`scripts/nitrogen/nitrogen_onnx.py light`), quantized to 8 bits:

- its tower: Google's SigLIP-base/16 vision tower, google/siglip-base-patch16-224 at revision
  7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed (https://huggingface.co/google/siglip-base-patch16-224),
  under the Apache License 2.0 (`SIGLIP_LICENSE`). Its layers 0-4 are Google's as published;
  layers 5-10 were trained further here.
- its adapter and gate, trained here.

The tower's later layers, the adapter and the gate were trained to reproduce what NVIDIA's
NitroGen does with its own image features, so the NVIDIA License (`LICENSE`: non-commercial
research use only) applies to these files as it does to NitroGen.
