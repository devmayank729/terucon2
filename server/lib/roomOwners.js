/**
 * Who made each saved room. The studio keeps every visitor's rooms in one pile (swatchroom/server/routes/rooms.js: anyone who
 * can reach /api/rooms can list, open and delete any room), and its passcode is what used to keep strangers out. With the
 * passcode off, server/lib/studioShield.js uses this list to give each browser only its own rooms.
 *
 * The list is a separate MongoDB collection (`room_owners`) made here, through the studio's own mongoose connection. The studio's
 * rooms and files are never written to or changed by this: a room's record only gets a second record next to it.
 */

/**
 * @param {{mongoose: import('mongoose').Mongoose, Room: import('mongoose').Model<any>}} studio the studio's own mongoose and Room model
 * @returns {import('./studioShield.js').RoomStore}
 */
export function mongoRoomOwners({ mongoose, Room }) {
  const Owner =
    mongoose.models.RoomOwner ??
    mongoose.model(
      'RoomOwner',
      new mongoose.Schema({ _id: { type: String, required: true }, owner: { type: String, required: true, index: true }, createdAt: { type: Number, default: Date.now } }, { versionKey: false }),
      'room_owners',
    );
  return {
    // MongoDB must be connected: without it the studio cannot save or list rooms either, and nothing is stored to protect.
    ready: () => mongoose.connection.readyState === 1,
    async ownerOf(id) {
      return (await Owner.findById(id).lean())?.owner ?? null;
    },
    async roomExists(id) {
      return Boolean(await Room.exists({ _id: id }));
    },
    async claim(id, owner) {
      try {
        await Owner.create({ _id: id, owner });
        return true;
      } catch (error) {
        if (error?.code === 11000) return false; // someone claimed it first
        throw error;
      }
    },
    async release(id) {
      await Owner.deleteOne({ _id: id });
    },
    async listOwned(owner) {
      const ids = (await Owner.find({ owner }).select('_id').limit(1000).lean()).map((entry) => entry._id);
      if (!ids.length) return [];
      const rooms = await Room.find({ _id: { $in: ids } })
        .sort({ updatedAt: -1 })
        .limit(60)
        .select('name updatedAt createdAt versions');
      return rooms.map((room) => room.summary());
    },
  };
}
