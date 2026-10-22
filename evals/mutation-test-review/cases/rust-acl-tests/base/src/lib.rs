//! Document access control.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Admin,
    Member,
    Guest,
}

pub struct User {
    pub id: u32,
    pub group_id: u32,
    pub role: Role,
}

pub struct Document {
    pub owner_id: u32,
    pub group_id: u32,
    pub public: bool,
}

/// Public documents are readable by everyone. Otherwise admins, the owner,
/// and members of the document's group may read.
pub fn can_read(user: &User, doc: &Document) -> bool {
    doc.public || user.role == Role::Admin || user.id == doc.owner_id || user.group_id == doc.group_id
}

/// Guests never write. Admins and the owner may write.
pub fn can_write(user: &User, doc: &Document) -> bool {
    if user.role == Role::Guest {
        return false;
    }
    user.role == Role::Admin || user.id == doc.owner_id
}
