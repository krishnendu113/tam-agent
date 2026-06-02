// Admin user management routes - list users, update role/status.

import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDb } from './db.js';

const router = Router();

/**
 * GET /api/admin/users
 * Returns all user documents with selected fields.
 */
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const users = await db.collection('users')
      .find({}, { projection: { name: 1, email: 1, role: 1, status: 1, lastLoginAt: 1, createdAt: 1 } })
      .toArray();

    return res.status(200).json(users);
  } catch (err) {
    console.error('[adminRoutes] Error listing users:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/admin/users/:id
 * Update a user's status or role.
 * Validates that the admin is not modifying their own account.
 * Only allows status: "active"|"disabled" and role: "admin"|"user".
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, role } = req.body;

    // Validate that at least one valid field is provided
    if (!status && !role) {
      return res.status(400).json({ error: 'No valid fields to update. Provide status or role.' });
    }

    // Validate allowed values
    if (status && !['active', 'disabled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value. Must be "active" or "disabled".' });
    }
    if (role && !['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role value. Must be "admin" or "user".' });
    }

    let objectId;
    try {
      objectId = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: 'Invalid user ID format.' });
    }

    const db = getDb();
    const usersCollection = db.collection('users');

    // Find the target user
    const targetUser = await usersCollection.findOne({ _id: objectId });
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent self-modification
    if (req.user.email === targetUser.email) {
      return res.status(400).json({ error: 'Cannot modify your own account' });
    }

    // Build update object
    const updateFields = { updatedAt: new Date() };
    if (status) updateFields.status = status;
    if (role) updateFields.role = role;

    await usersCollection.updateOne({ _id: objectId }, { $set: updateFields });

    // Return updated user
    const updatedUser = await usersCollection.findOne(
      { _id: objectId },
      { projection: { name: 1, email: 1, role: 1, status: 1, lastLoginAt: 1, createdAt: 1 } }
    );

    return res.status(200).json({ message: 'User updated', user: updatedUser });
  } catch (err) {
    console.error('[adminRoutes] Error updating user:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
