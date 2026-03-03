#!/bin/bash
# Transcode MP4 to HLS at multiple resolutions
# Usage: ./transcode.sh <input.mp4> <output-dir>
#
# Example: ./transcode.sh ./video.mp4 ./output/course-1/lesson-1
# This creates:
#   output/course-1/lesson-1/master.m3u8
#   output/course-1/lesson-1/720p/stream.m3u8 + *.ts
#   output/course-1/lesson-1/480p/stream.m3u8 + *.ts
#   output/course-1/lesson-1/360p/stream.m3u8 + *.ts

set -euo pipefail

INPUT="$1"
OUTDIR="$2"

if [ ! -f "$INPUT" ]; then
  echo "Error: Input file not found: $INPUT"
  exit 1
fi

echo "Transcoding: $INPUT -> $OUTDIR"

mkdir -p "$OUTDIR/720p" "$OUTDIR/480p" "$OUTDIR/360p"

# Segment duration
SEG=6

# 720p
ffmpeg -i "$INPUT" -y \
  -vf "scale=-2:720" -c:v libx264 -preset medium -crf 23 -maxrate 2500k -bufsize 5000k \
  -c:a aac -b:a 128k -ar 44100 \
  -hls_time $SEG -hls_playlist_type vod -hls_segment_filename "$OUTDIR/720p/seg%03d.ts" \
  "$OUTDIR/720p/stream.m3u8"

echo "720p done"

# 480p
ffmpeg -i "$INPUT" -y \
  -vf "scale=-2:480" -c:v libx264 -preset medium -crf 25 -maxrate 1200k -bufsize 2400k \
  -c:a aac -b:a 96k -ar 44100 \
  -hls_time $SEG -hls_playlist_type vod -hls_segment_filename "$OUTDIR/480p/seg%03d.ts" \
  "$OUTDIR/480p/stream.m3u8"

echo "480p done"

# 360p
ffmpeg -i "$INPUT" -y \
  -vf "scale=-2:360" -c:v libx264 -preset medium -crf 28 -maxrate 700k -bufsize 1400k \
  -c:a aac -b:a 64k -ar 44100 \
  -hls_time $SEG -hls_playlist_type vod -hls_segment_filename "$OUTDIR/360p/seg%03d.ts" \
  "$OUTDIR/360p/stream.m3u8"

echo "360p done"

# Master playlist
cat > "$OUTDIR/master.m3u8" << 'MASTER'
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2628000,RESOLUTION=1280x720
720p/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1296000,RESOLUTION=854x480
480p/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=764000,RESOLUTION=640x360
360p/stream.m3u8
MASTER

echo "Transcoding complete: $OUTDIR"
ls -lhR "$OUTDIR"/*.m3u8 "$OUTDIR"/*/stream.m3u8
