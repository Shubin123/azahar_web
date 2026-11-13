# The planner's game fine-tune

`lfm2.5-vl-450m-games.onnx` is the decoder graph of Liquid AI's LFM2.5-VL-450M
(LiquidAI/LFM2.5-VL-450M at revision fc6221ca597f3315e4f82fc2df606783267b34ba,
https://huggingface.co/LiquidAI/LFM2.5-VL-450M) fine-tuned for the AI player's planner (System
2): the ONNX decoder of onnx-community/LFM2.5-VL-450M-ONNX at revision
24e63007ff1aaafbde27c89eb01a0513f4f61482 (`decoder_model_merged_q4f16.onnx`), with, beside
each of its linear layers, a LoRA branch trained in this project
(`scripts/nitrogen/system2_finetune.py`) to answer the planner's questions about a game
screen and the player's notes as human players acted. Its 4-bit weights are the original's:
it names the original `decoder_model_merged_q4f16.onnx_data`, which the browser downloads
from huggingface.co.

This is a modified version of LFM2.5-VL-450M, under the LFM Open License v1.0 (`LICENSE`):
the changes were made in this project, by fine-tuning as described above.

It learned from NVIDIA's NitroGen dataset (https://huggingface.co/datasets/nvidia/NitroGen,
CC BY-NC 4.0: frames of public gameplay videos with the players' gamepad actions), for
non-commercial research use.
