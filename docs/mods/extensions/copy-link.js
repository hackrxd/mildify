/**
 * @name Copy song link
 * @description Adds "Copy song link" to the track menu.
 * @author Native Spotify
 * @version 1.0
 */

export default function (ns) {
  ns.addTrackMenuItem({
    label: "Copy song link",
    when: (track) => track.uri.startsWith("spotify:track:"),
    action: async (track) => {
      const id = track.uri.split(":")[2];
      await navigator.clipboard.writeText(`https://open.spotify.com/track/${id}`);
      ns.toasts.show(`Copied a link to ${track.name}`);
    },
  });
}
