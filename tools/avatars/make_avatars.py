#!/usr/bin/env python3
"""
Generate placeholder 3D avatars (.glb) for every bot in /bots.

Each avatar is a stylized chibi figure built from simple shapes, dressed in the
bot's appearance (palette, outfit details, props), with node animations whose
names match what the app plays:
  idle, sleep, look_at_user, listen, think, talk, work  (BotState)
  + the bot's signatureMoves (wave/point/thumbs-up style gestures)

No dependencies beyond numpy. Usage:
  python3 tools/avatars/make_avatars.py            # writes android/src/main/assets/avatars/*.glb
  python3 tools/avatars/make_avatars.py --out DIR

Replace any file with an artist-made GLB of the same name whenever you like;
keep the animation names the same.
"""
import argparse
import json
import math
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]

# ---------------------------------------------------------------- geometry


def box(sx, sy, sz):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    faces = [  # normal, 4 corners
        ((1, 0, 0), [(hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz), (hx, -hy, hz)]),
        ((-1, 0, 0), [(-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz), (-hx, -hy, -hz)]),
        ((0, 1, 0), [(-hx, hy, -hz), (-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz)]),
        ((0, -1, 0), [(-hx, -hy, hz), (-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz)]),
        ((0, 0, 1), [(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]),
        ((0, 0, -1), [(hx, -hy, -hz), (-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz)]),
    ]
    pos, nrm, idx = [], [], []
    for n, quad in faces:
        b = len(pos)
        pos += quad
        nrm += [n] * 4
        idx += [b, b + 1, b + 2, b, b + 2, b + 3]
    return np.array(pos, np.float32), np.array(nrm, np.float32), np.array(idx, np.uint16)


def sphere(r, seg=28, rings=18, sy=1.0):
    pos, nrm, idx = [], [], []
    for i in range(rings + 1):
        v = i / rings
        phi = v * math.pi
        for j in range(seg + 1):
            u = j / seg
            th = u * 2 * math.pi
            n = (math.sin(phi) * math.cos(th), math.cos(phi), math.sin(phi) * math.sin(th))
            pos.append((n[0] * r, n[1] * r * sy, n[2] * r))
            nrm.append(n)
    for i in range(rings):
        for j in range(seg):
            a = i * (seg + 1) + j
            b = a + seg + 1
            idx += [a, a + 1, b, b, a + 1, b + 1]
    return np.array(pos, np.float32), np.array(nrm, np.float32), np.array(idx, np.uint16)


def cylinder(r, h, seg=16, r_top=None):
    r_top = r if r_top is None else r_top
    pos, nrm, idx = [], [], []
    for j in range(seg + 1):
        th = j / seg * 2 * math.pi
        c, s = math.cos(th), math.sin(th)
        pos += [(c * r, -h / 2, s * r), (c * r_top, h / 2, s * r_top)]
        nrm += [(c, 0, s), (c, 0, s)]
    for j in range(seg):
        a = j * 2
        idx += [a, a + 1, a + 2, a + 2, a + 1, a + 3]
    for y, ny, rr in ((h / 2, 1, r_top), (-h / 2, -1, r)):  # caps
        center = len(pos)
        pos.append((0, y, 0))
        nrm.append((0, ny, 0))
        for j in range(seg + 1):
            th = j / seg * 2 * math.pi
            pos.append((math.cos(th) * rr, y, math.sin(th) * rr))
            nrm.append((0, ny, 0))
        for j in range(seg):
            a, b = center + 1 + j, center + 2 + j
            idx += [center, b, a] if ny > 0 else [center, a, b]
    return np.array(pos, np.float32), np.array(nrm, np.float32), np.array(idx, np.uint16)


def torus(R, r, seg=20, tube=8):
    pos, nrm, idx = [], [], []
    for i in range(seg + 1):
        u = i / seg * 2 * math.pi
        for j in range(tube + 1):
            v = j / tube * 2 * math.pi
            n = (math.cos(u) * math.cos(v), math.sin(v), math.sin(u) * math.cos(v))
            pos.append(((R + r * math.cos(v)) * math.cos(u), r * math.sin(v), (R + r * math.cos(v)) * math.sin(u)))
            nrm.append(n)
    for i in range(seg):
        for j in range(tube):
            a = i * (tube + 1) + j
            b = a + tube + 1
            idx += [a, b, a + 1, a + 1, b, b + 1]
    return np.array(pos, np.float32), np.array(nrm, np.float32), np.array(idx, np.uint16)


# ---------------------------------------------------------------- math


def quat(axis, deg):
    ax = np.array(axis, float)
    ax /= np.linalg.norm(ax)
    h = math.radians(deg) / 2
    return [float(ax[0] * math.sin(h)), float(ax[1] * math.sin(h)), float(ax[2] * math.sin(h)), float(math.cos(h))]


def qmul(a, b):
    x1, y1, z1, w1 = a
    x2, y2, z2, w2 = b
    return [w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
            w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
            w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
            w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2]


Q0 = [0.0, 0.0, 0.0, 1.0]


def hexrgb(h):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return lin + [1.0]


# ---------------------------------------------------------------- glTF writer


class Gltf:
    def __init__(self):
        self.bin = bytearray()
        self.j = {"asset": {"version": "2.0", "generator": "GBXR make_avatars.py"}, "scene": 0,
                  "scenes": [{"nodes": []}], "nodes": [], "meshes": [], "materials": [],
                  "accessors": [], "bufferViews": [], "animations": []}
        self.mat_ids = {}
        self.node_ids = {}

    def _view(self, data: bytes, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        bv = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            bv["target"] = target
        self.j["bufferViews"].append(bv)
        return len(self.j["bufferViews"]) - 1

    def _acc(self, arr, typ, comp, target=None, minmax=False):
        a = {"bufferView": self._view(arr.tobytes(), target), "componentType": comp,
             "count": int(arr.shape[0]), "type": typ}
        if minmax:
            flat = arr.reshape(arr.shape[0], -1)
            a["min"] = [float(v) for v in flat.min(axis=0)]
            a["max"] = [float(v) for v in flat.max(axis=0)]
        self.j["accessors"].append(a)
        return len(self.j["accessors"]) - 1

    def material(self, color, rough=0.75, metal=0.0, emissive=None):
        key = (tuple(color), rough, metal, tuple(emissive or ()))
        if key not in self.mat_ids:
            m = {"pbrMetallicRoughness": {"baseColorFactor": color, "roughnessFactor": rough, "metallicFactor": metal}}
            if emissive:
                m["emissiveFactor"] = emissive
            self.j["materials"].append(m)
            self.mat_ids[key] = len(self.j["materials"]) - 1
        return self.mat_ids[key]

    def mesh(self, geo, mat):
        p, n, i = geo
        prim = {"attributes": {"POSITION": self._acc(p, "VEC3", 5126, 34962, True),
                               "NORMAL": self._acc(n, "VEC3", 5126, 34962)},
                "indices": self._acc(i, "SCALAR", 5123, 34963), "material": mat}
        self.j["meshes"].append({"primitives": [prim]})
        return len(self.j["meshes"]) - 1

    def node(self, name, parent=None, t=(0, 0, 0), r=None, s=None, mesh=None):
        n = {"name": name, "translation": [float(v) for v in t]}
        if r:
            n["rotation"] = r
        if s:
            n["scale"] = [float(v) for v in s]
        if mesh is not None:
            n["mesh"] = mesh
        self.j["nodes"].append(n)
        idx = len(self.j["nodes"]) - 1
        self.node_ids[name] = idx
        if parent is None:
            self.j["scenes"][0]["nodes"].append(idx)
        else:
            self.j["nodes"][self.node_ids[parent]].setdefault("children", []).append(idx)
        return idx

    def part(self, name, parent, geo, color, t=(0, 0, 0), r=None, s=None, **mat):
        return self.node(name, parent, t, r, s, self.mesh(geo, self.material(color, **mat)))

    def animation(self, name, tracks):
        """tracks: {(node, path): [(time, value), ...]}"""
        anim = {"name": name, "samplers": [], "channels": []}
        for (node, path), keys in tracks.items():
            times = np.array([k[0] for k in keys], np.float32)
            vals = np.array([k[1] for k in keys], np.float32)
            si = len(anim["samplers"])
            anim["samplers"].append({"input": self._acc(times, "SCALAR", 5126, minmax=True),
                                     "output": self._acc(vals, "VEC4" if path == "rotation" else "VEC3", 5126),
                                     "interpolation": "LINEAR"})
            anim["channels"].append({"sampler": si, "target": {"node": self.node_ids[node], "path": path}})
        self.j["animations"].append(anim)

    def write(self, path: Path):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.j["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.j, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
            f.write(struct.pack("<II", len(self.bin), 0x004E4942) + bytes(self.bin))


# ---------------------------------------------------------------- characters

SKIN = hexrgb("#E8B894")
DARK = hexrgb("#222222")
WHITE = hexrgb("#FFFFFF")
GOLD = hexrgb("#D4AF37")

# Rest pose of animated joints (local translation, rotation).
JOINTS = {
    "body": ((0, 0.25, 0), Q0),
    "head": ((0, 0.34, 0), Q0),
    "armL": ((0.17, 0.27, 0), quat((0, 0, 1), 8)),
    "armR": ((-0.17, 0.27, 0), quat((0, 0, 1), -8)),
    "mouth": ((0, -0.015, 0.19), Q0),
}

HAIR = {"juno": "#5A3A22", "nova": "#2B2B2B", "pantry": "#8B5A2B", "chief": "#3A3A3A", "pillpal": "#6B4226",
        "doorman": "#BDBDBD", "mailguard": "#1E1E1E", "finder": "#C26A2B", "storykeeper": "#D9D9D9", "coach": "#3B2F2F"}


def build(bot):
    g = Gltf()
    a = bot["appearance"]
    pal = [hexrgb(c) for c in a.get("palette", [])] + [hexrgb("#777777")] * 3
    main, second, accent = pal[0], pal[1], pal[2]
    hair = hexrgb(HAIR.get(bot["id"], "#4A3728"))
    arch = a["archetype"].lower()
    bid = bot["id"]

    g.node("root")
    g.part("legL", "root", cylinder(0.045, 0.25), DARK, t=(0.06, 0.125, 0))
    g.part("legR", "root", cylinder(0.045, 0.25), DARK, t=(-0.06, 0.125, 0))
    g.part("shoeL", "root", box(0.09, 0.04, 0.13), DARK, t=(0.06, 0.02, 0.02), rough=0.4)
    g.part("shoeR", "root", box(0.09, 0.04, 0.13), DARK, t=(-0.06, 0.02, 0.02), rough=0.4)

    g.node("body", "root", *JOINTS["body"])
    long_coat = bid in ("chief", "doorman", "finder")
    g.part("torso", "body", cylinder(0.14, 0.32, r_top=0.12), main, t=(0, 0.16, 0))
    if long_coat:
        g.part("coatTail", "body", cylinder(0.16, 0.18, r_top=0.14), main, t=(0, -0.02, 0))
    # Shirt / collar front.
    g.part("shirt", "body", box(0.08, 0.2, 0.02), second, t=(0, 0.2, 0.12))

    # Outfit details by archetype.
    if bid == "pantry":
        g.part("tie", "body", box(0.035, 0.17, 0.015), accent, t=(0, 0.18, 0.135))
        g.part("nameTag", "body", box(0.07, 0.035, 0.01), WHITE, t=(0.07, 0.24, 0.125))
    if bid == "chief":
        g.part("lapelPin", "body", sphere(0.015, 8, 6), GOLD, t=(0.06, 0.26, 0.125), metal=1.0, rough=0.3)
    if bid in ("doorman",):
        for k, y in enumerate((0.09, 0.15, 0.21, 0.27)):
            g.part(f"button{k}", "body", sphere(0.012, 8, 6), GOLD, t=(0.03, y, 0.13), metal=1.0, rough=0.3)
    if bid in ("mailguard", "pillpal"):
        g.part("badge", "body", box(0.045, 0.05, 0.01), accent if bid == "pillpal" else GOLD,
               t=(0.07, 0.25, 0.125), metal=0.6 if bid == "mailguard" else 0.0)
    if bid == "nova":
        g.part("hood", "body", torus(0.09, 0.035), main, t=(0, 0.33, -0.04), r=quat((1, 0, 0), 70))
        g.part("headphones", "body", torus(0.085, 0.018), DARK, t=(0, 0.33, 0.02), r=quat((1, 0, 0), 90))
    if bid == "storykeeper":
        g.part("cardiganL", "body", box(0.03, 0.3, 0.02), main, t=(0.05, 0.16, 0.13))
        g.part("cardiganR", "body", box(0.03, 0.3, 0.02), main, t=(-0.05, 0.16, 0.13))

    # Head.
    g.node("head", "body", *JOINTS["head"])
    g.part("face", "head", sphere(0.2, sy=0.95), SKIN, t=(0, 0.05, 0))
    g.part("hair", "head", sphere(0.205, sy=0.75), hair, t=(0, 0.11, -0.03))
    g.part("eyeL", "head", sphere(0.028, 10, 8), DARK, t=(0.07, 0.06, 0.175), rough=0.2)
    g.part("eyeR", "head", sphere(0.028, 10, 8), DARK, t=(-0.07, 0.06, 0.175), rough=0.2)
    g.part("shineL", "head", sphere(0.009, 6, 4), WHITE, t=(0.077, 0.07, 0.2), emissive=[0.6, 0.6, 0.6])
    g.part("shineR", "head", sphere(0.009, 6, 4), WHITE, t=(-0.063, 0.07, 0.2), emissive=[0.6, 0.6, 0.6])
    g.node("mouth", "head", *JOINTS["mouth"])
    g.part("mouthShape", "mouth", box(0.06, 0.018, 0.01), hexrgb("#7A2E2E"))
    g.part("cheekL", "head", sphere(0.025, 8, 6, sy=0.6), hexrgb("#F2A0A0"), t=(0.12, -0.0, 0.15))
    g.part("cheekR", "head", sphere(0.025, 8, 6, sy=0.6), hexrgb("#F2A0A0"), t=(-0.12, -0.0, 0.15))

    if any(w in arch for w in ("secretary", "nerd", "grandmother")):
        thick = 0.012 if "nerd" in arch else 0.007
        frame = DARK if "nerd" in arch else accent
        g.part("glassL", "head", torus(0.04, thick), frame, t=(0.07, 0.06, 0.19), r=quat((1, 0, 0), 90))
        g.part("glassR", "head", torus(0.04, thick), frame, t=(-0.07, 0.06, 0.19), r=quat((1, 0, 0), 90))
        g.part("glassBridge", "head", box(0.06, thick * 1.5, thick), frame, t=(0, 0.065, 0.195))
    if bid in ("juno", "storykeeper"):
        g.part("bun", "head", sphere(0.07), hair, t=(0, 0.22, -0.08))
    if bid == "juno":
        g.part("pencil", "head", cylinder(0.008, 0.14), hexrgb("#F2C14E"), t=(0, 0.23, -0.08), r=quat((0, 0, 1), 70))
    if bid in ("doorman", "mailguard"):
        g.part("capBand", "head", cylinder(0.19, 0.06), main, t=(0, 0.2, 0))
        g.part("capTop", "head", cylinder(0.2, 0.05, r_top=0.21), main, t=(0, 0.25, 0))
        g.part("capBill", "head", box(0.2, 0.015, 0.1), DARK, t=(0, 0.18, 0.18), rough=0.3)
    if bid == "finder":
        g.part("hatBrim", "head", cylinder(0.24, 0.02), main, t=(0, 0.17, 0))
        g.part("hatTop", "head", sphere(0.19, sy=0.55), main, t=(0, 0.19, 0))
    if bid == "coach":
        g.part("headband", "head", torus(0.2, 0.02), main, t=(0, 0.12, 0))
    if bid == "chief":
        g.part("hairSwoop", "head", sphere(0.12, sy=0.5), hair, t=(0.05, 0.2, 0.05))

    # Arms (pivot at shoulder, hanging down).
    for side, sgn in (("L", 1), ("R", -1)):
        g.node(f"arm{side}", "body", *JOINTS[f"arm{side}"])
        g.part(f"sleeve{side}", f"arm{side}", cylinder(0.04, 0.2), main, t=(0, -0.1, 0))
        g.part(f"hand{side}", f"arm{side}", sphere(0.045), SKIN, t=(0, -0.22, 0))

    # Props in hands.
    props = " ".join(a.get("props", [])).lower()
    if "clipboard" in props:
        g.part("clipboard", "armL", box(0.14, 0.18, 0.015), hexrgb("#8B5A2B"), t=(0, -0.25, 0.06), r=quat((1, 0, 0), -20))
        g.part("paper", "armL", box(0.12, 0.15, 0.005), WHITE, t=(0, -0.25, 0.07), r=quat((1, 0, 0), -20))
    if "laptop" in props:
        g.part("laptop", "armL", box(0.2, 0.012, 0.14), hexrgb("#9AA0A6"), t=(-0.08, -0.24, 0.08), metal=0.6, rough=0.4)
        g.part("laptopSticker", "armL", box(0.05, 0.004, 0.05), accent, t=(-0.08, -0.232, 0.08), emissive=accent[:3])
    if "tablet" in props or "hologram task board" in props:
        g.part("tablet", "armL", box(0.12, 0.17, 0.01), DARK, t=(0, -0.25, 0.06), rough=0.2)
        g.part("tabletGlow", "armL", box(0.1, 0.14, 0.004), hexrgb("#4FC3F7"), t=(0, -0.25, 0.067), emissive=[0.2, 0.6, 0.9])
    if "coupon" in props:
        for k in range(3):
            g.part(f"coupon{k}", "armR", box(0.09, 0.05, 0.004), hexrgb("#F2C14E") if k % 2 else WHITE,
                   t=(0, -0.26, 0.05 + k * 0.004), r=quat((0, 0, 1), -20 + k * 20))
    if "magnifying" in props:
        g.part("lensRing", "armR", torus(0.05, 0.01), DARK, t=(0, -0.33, 0.05), r=quat((1, 0, 0), 90))
        g.part("lensHandle", "armR", cylinder(0.01, 0.08), hexrgb("#5C4033"), t=(0, -0.26, 0.05))
    if "whistle" in props:
        g.part("whistle", "body", box(0.03, 0.02, 0.04), hexrgb("#C0C0C0"), t=(0, 0.2, 0.15), metal=1.0, rough=0.3)
    if "teacup" in props or "water cup" in props:
        g.part("cup", "armR", cylinder(0.035, 0.05, r_top=0.045), WHITE, t=(0, -0.28, 0.04))
    if "umbrella" in props:
        g.part("umbrella", "armR", cylinder(0.012, 0.3), DARK, t=(0, -0.3, 0.03))
    if "pill organizer" in props:
        g.part("pillbox", "armL", box(0.14, 0.03, 0.05), hexrgb("#7FDBDA"), t=(0, -0.26, 0.05))
    if "flashlight" in props:
        g.part("flashlight", "armR", cylinder(0.018, 0.1), DARK, t=(0, -0.28, 0.04), r=quat((1, 0, 0), 90))
    if "knitting" in props:
        g.part("yarn", "armL", sphere(0.05), accent, t=(0, -0.27, 0.05))

    for name, tracks in animations(a.get("signatureMoves", [])).items():
        g.animation(name, tracks)
    return g


# ---------------------------------------------------------------- animation

# Right arm sits on -X: raising it up-and-out is a negative turn about Z (left arm: positive).
ARM_UP_R = quat((0, 0, 1), -140)
ARM_UP_L = quat((0, 0, 1), 140)
WAVE_R = quat((0, 0, 1), -115)
FWD_R = quat((1, 0, 0), -80)       # arm reaching forward
FWD_L = quat((1, 0, 0), -80)


def clip(duration, **joint_keys):
    """joint_keys: joint -> list of (t_fraction, translation|None, rotation|None, scale|None).
    Joints not given hold their rest pose, so clips never inherit a stale pose."""
    tracks = {}
    for j, (rt, rr) in JOINTS.items():
        keys = joint_keys.get(j)
        if keys is None:
            keys = [(0, None, None, None), (1, None, None, None)]
        tracks[(j, "translation")] = [(f * duration, list(t) if t else list(rt)) for f, t, _, _ in keys]
        tracks[(j, "rotation")] = [(f * duration, r if r else rr) for f, _, r, _ in keys]
        if j == "mouth":
            tracks[(j, "scale")] = [(f * duration, list(s) if s else [1, 1, 1]) for f, _, _, s in keys]
    return tracks


def bob(dy, n=2):
    base = JOINTS["body"][0]
    return [(i / (2 * n), (base[0], base[1] + (dy if i % 2 else 0), base[2]), None, None) for i in range(2 * n + 1)]


def animations(signature_moves):
    rest_r = JOINTS["armR"][1]
    rest_l = JOINTS["armL"][1]
    head_tilt = lambda deg: quat((0, 0, 1), deg)
    clips = {
        "idle": clip(3.0, body=bob(0.008, 1),
                     head=[(0, None, Q0, None), (0.5, None, quat((0, 1, 0), 8), None), (1, None, Q0, None)]),
        "sleep": clip(4.0, body=[(0, (0, 0.24, 0), quat((1, 0, 0), 8), None), (0.5, (0, 0.235, 0), quat((1, 0, 0), 10), None),
                                 (1, (0, 0.24, 0), quat((1, 0, 0), 8), None)],
                      head=[(0, None, quat((1, 0, 0), 25), None), (0.5, None, qmul(quat((1, 0, 0), 28), head_tilt(6)), None),
                            (1, None, quat((1, 0, 0), 25), None)]),
        "look_at_user": clip(1.2, body=[(0, None, None, None), (0.3, (0, 0.28, 0), None, None), (0.6, None, None, None), (1, None, None, None)],
                             head=[(0, None, Q0, None), (0.3, None, quat((1, 0, 0), -10), None), (1, None, head_tilt(-6), None)],
                             armR=[(0, None, rest_r, None), (0.4, None, WAVE_R, None), (0.6, None, ARM_UP_R, None),
                                   (0.8, None, WAVE_R, None), (1, None, rest_r, None)]),
        "listen": clip(2.0, head=[(0, None, head_tilt(10), None), (0.5, None, head_tilt(14), None), (1, None, head_tilt(10), None)],
                       armL=[(0, None, quat((0, 0, 1), 155), None), (1, None, quat((0, 0, 1), 155), None)]),  # hand by the ear
        "think": clip(2.5, head=[(0, None, qmul(quat((1, 0, 0), -10), head_tilt(-8)), None), (0.5, None, qmul(quat((1, 0, 0), -14), head_tilt(-10)), None),
                                 (1, None, qmul(quat((1, 0, 0), -10), head_tilt(-8)), None)],
                      armR=[(0, None, qmul(quat((1, 0, 0), -120), quat((0, 0, 1), -20)), None), (1, None, qmul(quat((1, 0, 0), -120), quat((0, 0, 1), -20)), None)]),
        "talk": clip(1.6, mouth=[(f, None, None, (1, 1 + 2.5 * abs(math.sin(f * math.pi * 4)), 1)) for f in [i / 16 for i in range(17)]],
                     head=[(0, None, Q0, None), (0.25, None, quat((1, 0, 0), 5), None), (0.5, None, Q0, None),
                           (0.75, None, quat((1, 0, 0), 5), None), (1, None, Q0, None)],
                     armR=[(0, None, rest_r, None), (0.5, None, qmul(quat((1, 0, 0), -45), quat((0, 0, 1), -20)), None), (1, None, rest_r, None)]),
        "work": clip(1.0, armL=[(0, None, quat((1, 0, 0), -60), None), (0.25, None, quat((1, 0, 0), -70), None), (0.5, None, quat((1, 0, 0), -60), None),
                                (0.75, None, quat((1, 0, 0), -70), None), (1, None, quat((1, 0, 0), -60), None)],
                     armR=[(0, None, quat((1, 0, 0), -70), None), (0.25, None, quat((1, 0, 0), -60), None), (0.5, None, quat((1, 0, 0), -70), None),
                           (0.75, None, quat((1, 0, 0), -60), None), (1, None, quat((1, 0, 0), -70), None)],
                     head=[(0, None, quat((1, 0, 0), 12), None), (1, None, quat((1, 0, 0), 12), None)]),
    }

    # Gesture library for signature moves, picked by keywords in the move name.
    wave = clip(1.6, armR=[(0, None, rest_r, None), (0.2, None, ARM_UP_R, None), (0.35, None, WAVE_R, None),
                           (0.5, None, ARM_UP_R, None), (0.65, None, WAVE_R, None), (0.8, None, ARM_UP_R, None), (1, None, rest_r, None)])
    point = clip(1.5, armR=[(0, None, rest_r, None), (0.3, None, qmul(FWD_R, quat((0, 1, 0), 20)), None), (0.8, None, qmul(FWD_R, quat((0, 1, 0), 20)), None),
                            (1, None, rest_r, None)], head=[(0, None, Q0, None), (0.3, None, quat((0, 1, 0), -15), None), (1, None, Q0, None)])
    thumbs = clip(1.2, armR=[(0, None, rest_r, None), (0.3, None, qmul(quat((1, 0, 0), -90), quat((0, 0, 1), -30)), None),
                             (0.8, None, qmul(quat((1, 0, 0), -90), quat((0, 0, 1), -30)), None), (1, None, rest_r, None)],
                  body=[(0, None, None, None), (0.4, None, quat((0, 0, 1), 4), None), (1, None, None, None)])
    face_touch = clip(1.4, armR=[(0, None, rest_r, None), (0.35, None, qmul(quat((1, 0, 0), -140), quat((0, 0, 1), -25)), None),
                                 (0.7, None, qmul(quat((1, 0, 0), -140), quat((0, 0, 1), -25)), None), (1, None, rest_r, None)])
    look_down_item = clip(1.8, armL=[(0, None, rest_l, None), (0.3, None, FWD_L, None), (0.8, None, FWD_L, None), (1, None, rest_l, None)],
                          head=[(0, None, Q0, None), (0.3, None, quat((1, 0, 0), 20), None), (0.8, None, quat((1, 0, 0), 20), None), (1, None, Q0, None)])
    arms_crossed = clip(2.0, armL=[(0, None, qmul(quat((1, 0, 0), -70), quat((0, 1, 0), 60)), None), (1, None, qmul(quat((1, 0, 0), -70), quat((0, 1, 0), 60)), None)],
                        armR=[(0, None, qmul(quat((1, 0, 0), -70), quat((0, 1, 0), -60)), None), (1, None, qmul(quat((1, 0, 0), -70), quat((0, 1, 0), -60)), None)],
                        head=[(0, None, Q0, None), (0.5, None, quat((1, 0, 0), -6), None), (1, None, Q0, None)])
    nod = clip(1.0, head=[(0, None, Q0, None), (0.25, None, quat((1, 0, 0), 15), None), (0.5, None, Q0, None), (0.75, None, quat((1, 0, 0), 15), None), (1, None, Q0, None)])
    stretch = clip(2.0, armL=[(0, None, rest_l, None), (0.4, None, ARM_UP_L, None), (0.7, None, ARM_UP_L, None), (1, None, rest_l, None)],
                   armR=[(0, None, rest_r, None), (0.4, None, ARM_UP_R, None), (0.7, None, ARM_UP_R, None), (1, None, rest_r, None)],
                   body=[(0, None, None, None), (0.5, (0, 0.27, 0), None, None), (1, None, None, None)])
    hop = clip(0.8, body=bob(0.04, 2))

    library = [
        (("wave", "tip_cap", "hold_door", "assign"), wave),
        (("point", "present", "eureka", "finger"), point),
        (("thumbs", "clap", "nod_approval"), thumbs),
        (("glasses", "peer", "sip", "inspect", "magnifying", "jot"), face_touch),
        (("clipboard", "file", "check", "board", "chart", "review", "photos", "knit", "sort", "stamp", "offer", "fan", "polish", "tidy", "type"), look_down_item),
        (("arms_crossed", "attention"), arms_crossed),
        (("nod", "laugh", "hum"), nod),
        (("stretch", "demo"), stretch),
        (("jog", "bounce", "swing", "pace", "scan"), hop),
    ]
    for move in signature_moves:
        if move in clips:
            continue
        chosen = next((c for keys, c in library if any(k in move for k in keys)), wave)
        clips[move] = chosen
    return clips


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "android/src/main/assets/avatars"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for f in sorted((ROOT / "bots").glob("*.json")):
        bot = json.loads(f.read_text())
        if "appearance" not in bot:
            continue
        g = build(bot)
        dest = out / bot["avatar"]
        g.write(dest)
        print(f"{dest.relative_to(ROOT) if dest.is_relative_to(ROOT) else dest}: {dest.stat().st_size // 1024} KB, "
              f"{len(g.j['animations'])} animations")


if __name__ == "__main__":
    main()
