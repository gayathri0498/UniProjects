const bcrypt = require("bcrypt");

/**
 * Creates a new user object with hashed password
 * @param {Object} userData - Object containing username, password, role, status, approvedAt
 * @returns {Object} - User object ready to be inserted into MongoDB
 */
async function createUser(userData) {
  const { username, password, role, status, approvedAt = null } = userData;

  // Hash the password
  const passwordHash = await bcrypt.hash(password, 10);

  // Return MongoDB-ready user object
  return {
    username,
    passwordHash,
    role,
    status,
    approvedAt,
    createdAt: new Date(),
  };
}

module.exports = { createUser };