#!/usr/bin/env python3
"""cast -> agg GIF -> ffmpeg (caption band + key badges via ASS) -> MP4 + optimised GIF."""
import glob, json, os, subprocess, sys
from PIL import Image

BAND = 56
BG = '#0d1117'   # github-dark background

def ass_time(t):
    t = max(0, t); h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f'{h}:{m:02d}:{s:05.2f}'

def esc(s): return s.replace('\\', '\\\\').replace('{', '(').replace('}', ')')

def make_ass(meta, w, h, path):
    dur = meta['duration']
    lines = [
        '[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {w}', f'PlayResY: {h}', 'WrapStyle: 2', '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        # caption: centred in the band, light ink
        'Style: Cap,Menlo,19,&H00E6EDF3,&H00E6EDF3,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,150,150,18,1',
        # badge: bold, opaque box (BorderStyle 3), left of the band, cobalt box
        'Style: Key,Menlo,19,&H00FFFFFF,&H00FFFFFF,&H00F26F3D,&H00F26F3D,1,0,0,0,100,100,0,0,3,6,0,1,22,0,16,1',
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    caps = meta['caps']
    for i, (t, text) in enumerate(caps):
        end = caps[i + 1][0] if i + 1 < len(caps) else dur
        if text:
            lines.append(f'Dialogue: 0,{ass_time(t)},{ass_time(end)},Cap,,0,0,0,,{esc(text)}')
    b = meta['badges']
    for i, (t, label) in enumerate(b):
        end = min(t + 1.1, b[i + 1][0] if i + 1 < len(b) else dur)
        lines.append(f'Dialogue: 1,{ass_time(t)},{ass_time(end)},Key,,0,0,0,,{esc(label)}')
    open(path, 'w').write('\n'.join(lines) + '\n')

def render(cast, outdir, font_size=14, gif_fps=10):
    name = os.path.basename(cast).replace('.cast', '')
    meta = json.load(open(cast.replace('.cast', '.meta.json')))
    raw = os.path.join(outdir, name + '.raw.gif')
    subprocess.run(['agg', '--theme', 'github-dark', '--font-size', str(font_size), '--line-height', '1.2',
                    '--idle-time-limit', '999', '--fps-cap', '30', '--last-frame-duration', '2',
                    cast, raw], check=True, capture_output=True)
    w, h = Image.open(raw).size
    W, H = w + (w % 2), h + BAND + ((h + BAND) % 2)
    ass = os.path.join(outdir, name + '.ass')
    make_ass(meta, W, H, ass)
    vf = f"pad={W}:{H}:0:0:color={BG},subtitles={ass}"
    mp4 = os.path.join(outdir, name + '.mp4')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', raw, '-vf', vf + ',fps=30,format=yuv420p',
                    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', '-an', mp4], check=True)
    gif = os.path.join(outdir, name + '.gif')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', mp4, '-filter_complex',
                    f'fps={gif_fps},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
                    gif], check=True)
    os.remove(raw)
    print(f'{name}: {W}x{H} {meta["duration"]:.1f}s  mp4 {os.path.getsize(mp4)/1e6:.2f} MB  gif {os.path.getsize(gif)/1e6:.2f} MB')
    return mp4, gif

HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.dirname(HERE)

if __name__ == '__main__':
    casts = sys.argv[1:] or sorted(glob.glob(os.path.join(HERE, '.build', 'tui-*.cast')))
    for c in casts:
        mp4, gif = render(c, os.path.join(HERE, '.build'))
        os.replace(gif, os.path.join(MEDIA, os.path.basename(gif)))
