use acl::{can_read, can_write, Document, Role, User};

fn user(role: Role) -> User {
    User { id: 1, group_id: 1, role }
}

fn doc() -> Document {
    Document { owner_id: 1, group_id: 1, public: false }
}

#[test]
fn admin_can_read() {
    assert!(can_read(&user(Role::Admin), &doc()));
}

#[test]
fn owner_can_read() {
    assert!(can_read(&user(Role::Member), &doc()));
}

#[test]
fn group_member_can_read() {
    assert!(can_read(&user(Role::Member), &doc()));
}

#[test]
fn admin_can_write() {
    assert!(can_write(&user(Role::Admin), &doc()));
}

#[test]
fn owner_can_write() {
    assert!(can_write(&user(Role::Member), &doc()));
}

#[test]
fn guest_cannot_write() {
    assert!(!can_write(&user(Role::Guest), &doc()));
}
