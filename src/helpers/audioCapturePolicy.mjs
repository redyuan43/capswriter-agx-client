export function buildSystemDefaultAudioCaptureProfiles() {
  return [
    {
      name: "system_default",
      constraints: {
        audio: true,
      },
    },
    {
      name: "system_default_raw",
      constraints: {
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      },
    },
  ];
}

export function stopMediaStreamTracks(stream) {
  if (!stream?.getTracks) {
    return 0;
  }
  const tracks = stream.getTracks();
  tracks.forEach((track) => track.stop());
  return tracks.length;
}
