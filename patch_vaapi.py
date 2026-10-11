#!/usr/bin/env python3
"""
KonomiTV VA-API (i965) パッチ
Celeron N2830 (Bay Trail) など、QSVEncC が動かない古い Intel GPU で
FFmpeg の h264_vaapi を使ってライブ視聴をハードウェアエンコードするための改造。

使い方: KonomiTV のフォルダ (Dockerfile がある場所) で
    python3 patch_vaapi.py
を実行し、config.yaml の encoder を 'FFmpeg' にしてから
    docker compose up -d --build
で再ビルドする。

元に戻すとき:
    git checkout -- Dockerfile server/app/streams/LiveEncodingTask.py
"""

import sys
from pathlib import Path

MARK = '# [VAAPI-PATCH]'


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        sys.exit(f'エラー: {label} の書き換え位置が見つかりません (一致数: {count})。KonomiTV のバージョンが想定と違う可能性があります。')
    return text.replace(old, new)


def patch_live_encoding_task(path: Path) -> None:
    whole = path.read_text(encoding='utf-8')
    if MARK in whole:
        print(f'{path}: すでにパッチ適用済みです')
        return

    # 映像用の buildFFmpegOptions() の範囲だけを書き換える (ラジオ用の関数には触れない)
    start = whole.find('    def buildFFmpegOptions(self,')
    end = whole.find('    def buildFFmpegOptionsForRadio(self)')
    if start == -1 or end == -1 or end < start:
        sys.exit('エラー: buildFFmpegOptions() が見つかりません。KonomiTV のバージョンが想定と違う可能性があります。')
    src = whole[start:end]

    # 1. VA-API を使うかどうかのフラグ
    src = replace_once(src,
        "        # オプションの入る配列\n        options: list[str] = []\n\n        # 入力ストリームの解析時間",
        "        # オプションの入る配列\n        options: list[str] = []\n"
        f"        use_vaapi = os.environ.get('KONOMITV_FFMPEG_VAAPI') == '1'  {MARK}\n\n"
        "        # 入力ストリームの解析時間",
        'VA-API フラグ')

    # 2. 入力: MPEG-2 のデコードも GPU で行う
    src = replace_once(src,
        "        options.append(f'-f mpegts -analyzeduration {analyzeduration} -i pipe:0')",
        f"        if use_vaapi:  {MARK}\n"
        "            options.append('-hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi')\n"
        "        options.append(f'-f mpegts -analyzeduration {analyzeduration} -i pipe:0')",
        '入力オプション')

    # 3. コーデック: h264_vaapi
    src = replace_once(src,
        "        if QUALITY[quality].is_hevc is True:\n            options.append('-vcodec libx265')  # H.265/HEVC (通信節約モード)",
        f"        if use_vaapi:  {MARK}\n"
        "            options.append('-vcodec h264_vaapi')  # H.264 (VA-API)\n"
        "        elif QUALITY[quality].is_hevc is True:\n            options.append('-vcodec libx265')  # H.265/HEVC (通信節約モード)",
        'コーデック')

    # 4. -preset は libx264 専用なので VA-API では外す / プロファイルは high 固定
    src = replace_once(src,
        "        options.append('-preset veryfast -aspect 16:9')\n        if QUALITY[quality].is_hevc is True:",
        f"        options.append('-aspect 16:9' if use_vaapi else '-preset veryfast -aspect 16:9')  {MARK}\n"
        "        if QUALITY[quality].is_hevc is True and not use_vaapi:",
        'プリセット')

    # 5. フィルター: yadif / scale → deinterlace_vaapi / scale_vaapi
    src = replace_once(src,
        "            options.append(f'-vf scale={video_width}:{video_height}')",
        f"            options.append(f'-vf scale_vaapi=w={{video_width}}:h={{video_height}}' if use_vaapi else f'-vf scale={{video_width}}:{{video_height}}')  {MARK}",
        'BS4K フィルター')
    src = replace_once(src,
        "                options.append(f'-vf yadif=mode=1:parity=-1:deint=1,scale={video_width}:{video_height}')",
        f"                options.append(f'-vf deinterlace_vaapi=rate=field,scale_vaapi=w={{video_width}}:h={{video_height}}' if use_vaapi else f'-vf yadif=mode=1:parity=-1:deint=1,scale={{video_width}}:{{video_height}}')  {MARK}",
        '60fps フィルター')
    src = replace_once(src,
        "                    options.append(f'-vf pullup,dejudder,scale={video_width}:{video_height}')",
        f"                    options.append(f'-vf deinterlace_vaapi,scale_vaapi=w={{video_width}}:h={{video_height}}' if use_vaapi else f'-vf pullup,dejudder,scale={{video_width}}:{{video_height}}')  {MARK}",
        '24fps フィルター')
    src = replace_once(src,
        "                    options.append(f'-vf yadif=mode=0:parity=-1:deint=1,scale={video_width}:{video_height}')",
        f"                    options.append(f'-vf deinterlace_vaapi,scale_vaapi=w={{video_width}}:h={{video_height}}' if use_vaapi else f'-vf yadif=mode=0:parity=-1:deint=1,scale={{video_width}}:{{video_height}}')  {MARK}",
        '30fps フィルター')

    src = whole[:start] + src + whole[end:]

    # 6. 実行ファイル: VA-API 対応のシステムの FFmpeg を使う (ラジオも含めて FFmpeg 起動箇所は1つ)
    src = replace_once(src,
        "                    *[LIBRARY_PATH['FFmpeg'], *encoder_options],",
        "                    *[('/usr/bin/ffmpeg' if os.environ.get('KONOMITV_FFMPEG_VAAPI') == '1' else LIBRARY_PATH['FFmpeg']), *encoder_options],  "
        + MARK,
        'FFmpeg 実行パス')

    path.write_text(src, encoding='utf-8')
    print(f'{path}: パッチを適用しました')


def patch_dockerfile(path: Path) -> None:
    src = path.read_text(encoding='utf-8')
    if MARK in src:
        print(f'{path}: すでにパッチ適用済みです')
        return

    # システムの FFmpeg と i965 ドライバ (Bay Trail 世代対応) を追加
    src = replace_once(src,
        "        intel-media-va-driver-non-free intel-opencl-icd libigfxcmrt7 libmfx1 libmfxgen1 libva-drm2 libva-x11-2 \\\n",
        "        intel-media-va-driver-non-free intel-opencl-icd libigfxcmrt7 libmfx1 libmfxgen1 libva-drm2 libva-x11-2 \\\n"
        f"        {MARK} VA-API (i965) 用の FFmpeg とドライバ\n"
        "        ffmpeg i965-va-driver vainfo \\\n",
        'apt パッケージ')

    # 環境変数で i965 ドライバと VA-API モードを有効化
    src = replace_once(src,
        '\nENTRYPOINT ["/code/server/.venv/bin/python", "KonomiTV.py"]',
        f'\n{MARK} i965 ドライバで VA-API エンコードを使う\n'
        'ENV LIBVA_DRIVER_NAME=i965\n'
        'ENV KONOMITV_FFMPEG_VAAPI=1\n\n'
        'ENTRYPOINT ["/code/server/.venv/bin/python", "KonomiTV.py"]',
        'ENV 追加')

    path.write_text(src, encoding='utf-8')
    print(f'{path}: パッチを適用しました')


def main() -> None:
    root = Path.cwd()
    dockerfile = root / 'Dockerfile'
    task = root / 'server' / 'app' / 'streams' / 'LiveEncodingTask.py'
    if not dockerfile.exists() or not task.exists():
        sys.exit('エラー: KonomiTV のフォルダ (Dockerfile がある場所) で実行してください。')
    patch_live_encoding_task(task)
    patch_dockerfile(dockerfile)
    print('\n完了。config.yaml の encoder を \'FFmpeg\' にして、docker compose up -d --build で再ビルドしてください。')


if __name__ == '__main__':
    main()
